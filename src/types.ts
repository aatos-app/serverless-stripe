import type { AWS } from "@serverless/typescript";
import type { Stripe } from "stripe";

export interface WebhookConfig {
  functionName: string;
  events: [Stripe.Event.Type, ...Stripe.Event.Type[]];
  webhookSecretEnvVariableName: string;
}

type Value<T> = T[keyof T];
export type WebhookFunction = Value<AWS["functions"]>;

export interface StripeConfig {
  apiKey: string;
  webhooks: WebhookConfig[];
}

export interface Tags {
  [key: string]: string;
}

export interface CustomDomain {
  domainName: string;
  basePath: string;
}

export interface ServerlessInstance {
  service: {
    functions: AWS["functions"];
    service: string;
    provider: {
      stage: string;
      region?: string;
      profile?: string;
      stackName: string;
      compiledCloudFormationTemplate: {
        Outputs: any;
      };
      apiGateway: {
        restApiId: any;
        websocketApiId: any;
      };
      tags: Tags;
      stackTags: Tags;
    };
    custom: {
      customDomain?: CustomDomain;
      stripe?: StripeConfig;
    };
  };
  providers: {
    aws: {
      getCredentials();
    };
  };
  cli: {
    log(str: string, entity?: string);
  };

  addServiceOutputSection?(name: string, data: string[]);
}

export interface ServerlessOptions {
  stage: string;
  region?: string;
}

interface ServerlessProgress {
  update(message: string): void;

  remove(): void;
}

export interface ServerlessProgressFactory {
  get(name: string): ServerlessProgress;
}

export interface ServerlessUtils {
  writeText: (message: string) => void;
  log: {
    error(message: string): void;
    verbose(message: string): void;
    warning(message: string): void;
  };
  progress: ServerlessProgressFactory;
}
