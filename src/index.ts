// Importaciones de interfaces necesarias
import { Serverless, ServerlessOptions, Logger, ServerlessProvider } from './interfaces';
import chalk from 'chalk';

interface FunctionConfig {
  reservedConcurrency?: number;
  [key: string]: any;
}

interface ProcessingResult {
  modifiedCount: number;
  errorCount: number;
}

class StageBasedConcurrencyPlugin {
  private static readonly WARMUP_FUNCTION_IDENTIFIER = 'warmUp';
  private static readonly DEV_STAGES = ['dev', 'development', 'feature'];
  private static readonly AWS_CONCURRENCY_BATCH_SIZE = 5;
  private serverless: Serverless;
  private provider: ServerlessProvider;
  private log: Logger;
  private options: ServerlessOptions;
  public readonly hooks: Record<string, () => Promise<void>>;

  constructor(serverless: Serverless, options: ServerlessOptions) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this.log = this._createLegacyLogger();

    const stage = this.serverless.service.provider.stage;
    const isDev = this._isDevelopmentStage(stage);

    if (isDev) {
      this.log.info(`Development stage detected (${stage}). Plugin will remove reserved concurrency settings.`);
      this.hooks = {
        'before:deploy:deploy': this._removeReservedConcurrencyFromSLS.bind(this),
        'before:deploy:function:deploy': this._removeReservedConcurrencyFromSLS.bind(this),
        'before:package:createDeploymentArtifacts': this._removeReservedConcurrencyFromSLS.bind(this),
        'before:aws:deploy:deploy:createStack': this._removeReservedConcurrencyFromSLS.bind(this),
        'after:aws:deploy:deploy:updateStack': this._removeReservedConcurrencyFromAws.bind(this),
        'after:deploy:function:deploy': this._removeReservedConcurrencyFromAwsForFunction.bind(this),
      };
    } else {
      this.log.info(`Production stage detected (${stage}). Plugin will not modify any concurrency settings.`);
      this.hooks = {};
    }
  }

  private _isDevelopmentStage(stage: string): boolean {
    const lowerStage = stage.toLowerCase();
    return StageBasedConcurrencyPlugin.DEV_STAGES.includes(lowerStage) || lowerStage.startsWith('feature-');
  }

  async _removeReservedConcurrencyFromSLS(): Promise<void> {
    return this._measureExecutionTime('Remove reserved concurrency from Serverless config', async () => {
      const functions = (this.serverless.service.functions ?? {}) as Record<string, FunctionConfig>;
      const result = this._processServerlessConfigFunctions(functions);
      this._logServerlessConfigResult(result);
    });
  }

  private _processServerlessConfigFunctions(functions: Record<string, FunctionConfig>): ProcessingResult {
    let modifiedCount = 0;

    Object.entries(functions).forEach(([functionName, functionConfig]) => {
      if (this._removeConcurrencyFromFunction(functionName, functionConfig)) {
        modifiedCount++;
      }
    });

    return { modifiedCount, errorCount: 0 };
  }

  private _removeConcurrencyFromFunction(functionName: string, config: FunctionConfig): boolean {
    if (config.reservedConcurrency !== undefined) {
      this.log.info(`Removing reserved concurrency from Serverless config for function: ${functionName}`);
      delete config.reservedConcurrency;
      return true;
    }
    return false;
  }

  private _logServerlessConfigResult(result: ProcessingResult): void {
    if (result.modifiedCount > 0) {
      this.log.info(`Modified ${result.modifiedCount} functions to remove reserved concurrency settings`);
    } else {
      this.log.info('No functions with reserved concurrency found in Serverless config');
    }
  }

  async _removeReservedConcurrencyFromAws(): Promise<void> {
    return this._measureExecutionTime('Remove reserved concurrency from AWS for all functions', async () => {
      const functions = (this.serverless.service.functions ?? {}) as Record<string, FunctionConfig>;
      const result = await this._processAwsFunctionsInBatches(Object.entries(functions) as [string, FunctionConfig][]);
      this._logAwsResult(result);
    });
  }

  private async _processAwsFunctionsInBatches(functionEntries: [string, FunctionConfig][]): Promise<ProcessingResult> {
    let modifiedCount = 0;
    let errorCount = 0;
    const batchSize = StageBasedConcurrencyPlugin.AWS_CONCURRENCY_BATCH_SIZE;

    for (let i = 0; i < functionEntries.length; i += batchSize) {
      const batch = functionEntries.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(([functionName, _]) => this._processAwsFunction(functionName)));

      batchResults.forEach((result) => {
        modifiedCount += result.modifiedCount;
        errorCount += result.errorCount;
      });
    }

    return { modifiedCount, errorCount };
  }

  private async _processAwsFunction(functionName: string): Promise<ProcessingResult> {
    try {
      const awsFunctionName = this._getFunctionName(functionName);

      if (this._shouldSkipFunction(awsFunctionName)) {
        this.log.info(`Skipping warmUp function: ${awsFunctionName}`);
        return { modifiedCount: 0, errorCount: 0 };
      }

      const hasReservedConcurrency = await this._checkAndRemoveReservedConcurrency(awsFunctionName);
      return { modifiedCount: hasReservedConcurrency ? 1 : 0, errorCount: 0 };
    } catch (error) {
      this.log.error(
        `Error removing reserved concurrency from AWS for function ${functionName}: ${(error as Error).message}`
      );
      return { modifiedCount: 0, errorCount: 1 };
    }
  }

  private _shouldSkipFunction(awsFunctionName: string): boolean {
    return awsFunctionName.includes(StageBasedConcurrencyPlugin.WARMUP_FUNCTION_IDENTIFIER);
  }

  private async _checkAndRemoveReservedConcurrency(awsFunctionName: string): Promise<boolean> {
    const config = await this.provider.request('Lambda', 'getFunctionConfiguration', {
      FunctionName: awsFunctionName,
    });

    if (config.ReservedConcurrentExecutions !== undefined) {
      this.log.info(`Removing reserved concurrency from AWS for function: ${awsFunctionName}`);
      await this.provider.request('Lambda', 'deleteFunctionConcurrency', {
        FunctionName: awsFunctionName,
      });
      this.log.info(`Successfully removed reserved concurrency from AWS for function: ${awsFunctionName}`);
      return true;
    }

    return false;
  }

  private _logAwsResult(result: ProcessingResult): void {
    if (result.modifiedCount > 0) {
      this.log.info(`Successfully removed reserved concurrency from AWS for ${result.modifiedCount} functions`);
    } else if (result.errorCount === 0) {
      this.log.info('No functions with reserved concurrency found in AWS');
    }

    if (result.errorCount > 0) {
      this.log.error(`Failed to remove reserved concurrency for ${result.errorCount} functions`);
    }
  }

  private async _removeReservedConcurrencyFromAwsForFunction(): Promise<void> {
    return this._measureExecutionTime('Remove reserved concurrency from AWS for single function', async () => {
      const functionName = this.options.function;

      if (!this._validateFunctionName(functionName)) {
        return;
      }

      const result = await this._processSingleAwsFunction(functionName!);
      this._logSingleFunctionResult(functionName!, result);
    });
  }

  private _validateFunctionName(functionName: string | undefined): functionName is string {
    if (!functionName) {
      this.log.error('No function specified');
      return false;
    }
    return true;
  }

  private async _processSingleAwsFunction(functionName: string): Promise<ProcessingResult> {
    try {
      const awsFunctionName = this._getFunctionName(functionName);

      if (this._shouldSkipFunction(awsFunctionName)) {
        this.log.info(`Skipping warmUp function: ${awsFunctionName}`);
        return { modifiedCount: 0, errorCount: 0 };
      }

      const hasReservedConcurrency = await this._checkAndRemoveReservedConcurrency(awsFunctionName);
      return { modifiedCount: hasReservedConcurrency ? 1 : 0, errorCount: 0 };
    } catch (error) {
      this.log.error(
        `Error removing reserved concurrency from AWS for function ${functionName}: ${(error as Error).message}`
      );
      return { modifiedCount: 0, errorCount: 1 };
    }
  }

  private _logSingleFunctionResult(functionName: string, result: ProcessingResult): void {
    const awsFunctionName = this._getFunctionName(functionName);

    if (result.modifiedCount > 0) {
      this.log.info(`Successfully removed reserved concurrency from AWS for function: ${awsFunctionName}`);
    } else if (result.errorCount === 0) {
      this.log.info(`No reserved concurrency found for function: ${awsFunctionName}`);
    }
  }

  private _createLegacyLogger(): Logger {
    return {
      info: (message: string) => {
        if (this.serverless.cli?.log) {
          this.serverless.cli.log(`${chalk.magenta('[StageBasedConcurrencyPlugin]:')} ${message}`);
        } else {
          console.log(`${chalk.magenta('[StageBasedConcurrencyPlugin]:')} ${message}`); // eslint-disable-line no-console
        }
      },
      error: (message: string) => {
        if (this.serverless.cli?.log) {
          this.serverless.cli.log(`${chalk.redBright('[StageBasedConcurrencyPlugin]:')} ${message}`, 'ERROR');
        } else {
          console.error(`${chalk.redBright('[StageBasedConcurrencyPlugin]:')} ${message}`); // eslint-disable-line no-console
        }
      },
    };
  }

  private _getFunctionName(functionName: string): string {
    const { service } = this.serverless.service;
    const { stage } = this.serverless.service.provider;

    return `${service}-${stage}-${functionName}`;
  }

  private async _measureExecutionTime<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const timeStart = process.hrtime();
    this.log.info(`Starting: ${operation}`);

    try {
      const result = await fn();
      const timeEnd = process.hrtime(timeStart);
      this.log.info(`Finished: ${operation} in ${timeEnd[0]}s ${timeEnd[1] / 1e6}ms`);
      return result;
    } catch (error) {
      const timeEnd = process.hrtime(timeStart);
      this.log.error(`Failed: ${operation} after ${timeEnd[0]}s ${timeEnd[1] / 1e6}ms - ${(error as Error).message}`);
      throw error;
    }
  }
}

export = StageBasedConcurrencyPlugin;
