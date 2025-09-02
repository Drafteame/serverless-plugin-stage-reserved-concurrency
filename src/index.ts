// Importaciones de interfaces necesarias
import {
  Serverless,
  ServerlessOptions,
  Logger,
  ServerlessProvider
} from './interfaces';
import chalk from 'chalk';

class StageBasedConcurrencyPlugin {
  private serverless: Serverless;
  private provider: ServerlessProvider;
  private log: Logger;
  public readonly hooks: Record<string, () => Promise<void>>;

  constructor(serverless: Serverless, _options: ServerlessOptions) {
    this.serverless = serverless;
    this.provider = this.serverless.getProvider('aws');
    this.log = this._createLegacyLogger();
    
    const stage = this.serverless.service.provider.stage;
    const isDev = this._isDevelopmentStage(stage);
    
    if (isDev) {
      this.log.info(`Development stage detected (${stage}). Plugin will remove reserved concurrency settings.`);
      this.hooks = {
        'before:package:initialize': this._removeReservedConcurrencyFromSLS.bind(this),
        'after:deploy:deploy': this._removeReservedConcurrencyFromAws.bind(this),
        'after:deploy:function:deploy': this._removeReservedConcurrencyFromAws.bind(this),
      };
    } else {
      this.log.info(`Production stage detected (${stage}). Plugin will not modify any concurrency settings.`);
      this.hooks = {};
    }
  }

    private _isDevelopmentStage(stage: string): boolean {
      const lowerStage = stage.toLowerCase();
      return (
        lowerStage === 'dev' ||
        lowerStage === 'development' ||
        lowerStage === 'feature' ||
        lowerStage.startsWith('feature-')
      );
    }

    async _removeReservedConcurrencyFromSLS(): Promise<void> {
      return this._measureExecutionTime('Remove reserved concurrency from Serverless config', async () => {

        const functions = this.serverless.service.functions || {};
        let modifiedCount = 0;
        
        Object.entries(functions).forEach(([_, functionConfig]) => {
          const config = functionConfig as any;
        
          if (config.reservedConcurrency !== undefined) {
            delete config.reservedConcurrency;
            modifiedCount++;
          }
        });
    
        if (modifiedCount > 0) {
          this.log.info(`Modified ${modifiedCount} functions to remove reserved concurrency settings`);
        } else {
          this.log.info('No functions with reserved concurrency found in Serverless config');
        }
      });
    }

    private async _removeReservedConcurrencyFromAws(): Promise<void> {
      return this._measureExecutionTime('Remove reserved concurrency from AWS', async () => {
        const functions = this.serverless.service.functions || {};
        let modifiedCount = 0;
        let errorCount = 0;
        
        for (const [name, _] of Object.entries(functions)) {
          try {
            const functionName = this._getFunctionName(name);
            
            if (functionName.includes('warmUp')) {
              this.log.info(`Skipping warmUp function: ${functionName}`);
              continue;
            }

            const config = await this.provider.request('Lambda', 'getFunctionConfiguration', {
              FunctionName: functionName
            });
            
            if (config.ReservedConcurrentExecutions !== undefined) {
              this.log.info(`Removing reserved concurrency from AWS for function: ${functionName}`);
              
              await this.provider.request('Lambda', 'deleteFunctionConcurrency', {
                FunctionName: functionName
              });
              
              modifiedCount++;
            }
          } catch (error) {
            this.log.error(`Error removing reserved concurrency from AWS for function ${name}: ${(error as Error).message}`);
            errorCount++;
          }
        }
        
        if (modifiedCount > 0) {
          this.log.info(`Successfully removed reserved concurrency from AWS for ${modifiedCount} functions`);
        } else if (errorCount === 0) {
          this.log.info('No functions with reserved concurrency found in AWS');
        }
        
        if (errorCount > 0) {
          this.log.error(`Failed to remove reserved concurrency for ${errorCount} functions`);
        }
      });
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