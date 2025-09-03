# Serverless Plugin stage-based Reserved Concurrency

This is a [Serverless](https://www.serverless.com) plugin that allows you to remove the reserved concurrency settings from your Lambda functions in a specific stage.

## Installation

```bash
npm install serverless-plugin-stage-reserved-concurrency --save-dev
```

## Usage

Add the following to your `serverless.yml` file:

```yaml
plugins:
  - serverless-plugin-stage-reserved-concurrency
```

By default, the plugin will remove the reserved concurrency settings from your Lambda functions in the `dev` and `development` stages.