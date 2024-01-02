import type { AWS } from "@serverless/typescript";
import type { Stripe } from "stripe";

export interface WebhookConfig {
  functionName: string;
  events: [Stripe.Event.Type, ...Stripe.Event.Type[]];
  webhookSecretEnvVariableName: string;
}

export type StripePriceConfig = {
  id: string;
  price: number;
  currency: string;
  interval: "month" | "year";
  countryCode: string;
}

export interface StripeProductConfig {
  name: string;
  internal: {
    id: string;
    description: string;
  },
  prices: StripePriceConfig[];
}

export type StripePortalConfig = {
  configuration: Stripe.BillingPortal.ConfigurationCreateParams;
  internalId: string;
  envVariableName: string;
}

type Value<T> = T[keyof T];
export type WebhookFunction = Value<AWS["functions"]>;

export interface StripeConfig {
  apiKey: string;
  webhooks: WebhookConfig[];
  products: StripeProductConfig[];
  billingPortals: StripePortalConfig[];
}

export interface Tags {
  [key: string]: string;
}

export interface CustomDomain {
  domainName: string;
  basePath: string;
}

type Provider = AWS["functions"] & {
  custom:{
    customDomain?: CustomDomain;
    stripe?: StripeConfig;
  }
}

export interface ServerlessInstance {
  service: {
    functions: AWS["functions"];
    service: string;
    provider: Provider;
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
  processedInput: {
    commands: string[];
    options: ServerlessOptions;
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
