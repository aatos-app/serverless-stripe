"use strict";

import Globals from "./globals";
import {
  ServerlessInstance,
  ServerlessOptions,
  ServerlessUtils,
  WebhookConfig,
  CustomDomain,
  WebhookFunction,
  StripeProductConfig,
  StripePriceConfig,
} from "./types";
import Logging from "./logging";
import { Stripe } from "stripe";
import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";

type DeletedWebhook = {
  webhookId: string;
  url: string;
  lambda: string;
};
type MetadataBase = {
  stage: string;
  service: string;
  managedBy: string;
};
type WebhookMetadata = {
  lambda: string;
} & MetadataBase;

type ProductMetadata = {
  internalId: string;
} & MetadataBase;

type StripeProductEntry = {
  product: Stripe.Product;
  prices: Stripe.Price[];
};

class ServerlessStripe {
  // Serverless specific properties
  public serverless: ServerlessInstance;
  public options: ServerlessOptions;
  public commands: object;
  public hooks: object;
  public stage: string;
  public region: string;

  // Stripe specific properties
  private _stripe: Stripe;
  public webhooks: WebhookConfig[];
  public products: StripeProductConfig[];

  private stripeProducts: StripeProductEntry[] = [];

  private customDomain: CustomDomain;

  constructor(
    serverless: ServerlessInstance,
    options: ServerlessOptions,
    v3Utils?: ServerlessUtils
  ) {
    Globals.serverless = serverless;
    Globals.options = options;
    Globals.v3Utils = v3Utils;

    this.serverless = serverless;
    this.options = options;
    this.webhooks = this.serverless.service.custom.stripe.webhooks;
    this.products = this.serverless.service.custom.stripe.products ?? [];
    this.stage = this.serverless.processedInput.options.stage;
    this.region = this.serverless.service.provider.region as string;

    this.hooks = {
      "before:package:initialize": this.hookWrapper.bind(
        this,
        this.validateConfigExists
      ),
      "before:package:setupProviderConfiguration": this.hookWrapper.bind(
        this,
        this.createStripeWebhooksAndProducts
      ),
      "after:deploy:deploy": this.hookWrapper.bind(
        this,
        this.removeWebhooksNotInConfig
      ),
      "before:remove:remove": this.hookWrapper.bind(
        this,
        this.removeStripeWebhooks
      ),
    };
  }

  public async hookWrapper(lifecycleFunc: any) {
    this.validateConfigExists();
    return lifecycleFunc.call(this);
  }

  private getStripe() {
    if (!this._stripe) {
      this._stripe = new Stripe(this.serverless.service.custom.stripe.apiKey, {
        apiVersion: "2023-10-16",
      });
    }
    return this._stripe;
  }

  /**
   * Validate if the plugin config exists
   */
  public validateConfigExists(): void {
    if (!this.stage) {
      throw new Error(`${Globals.pluginName}: Stage is required.`);
    }
    if (!this.region) {
      throw new Error(`${Globals.pluginName}: Region is required.`);
    }
    if (typeof this.region !== "string") {
      throw new Error(`${Globals.pluginName}: Region must be a string.`);
    }
    this.customDomain = this.serverless.service.custom.customDomain;
    if (!this.customDomain) {
      throw new Error(
        `${Globals.pluginName}: Serverless Domain Manager required`
      );
    }

    if (!this.customDomain.domainName) {
      throw new Error(
        `${Globals.pluginName}: 'domainName' is required in 'customDomain' config`
      );
    }

    if (!this.customDomain.basePath) {
      throw new Error(
        `${Globals.pluginName}: 'basePath' is required in 'customDomain' config`
      );
    }
    // Make sure customDomain configuration exists, stop if not
    const config = this.serverless.service.custom;
    const stripeExists = config && typeof config.stripe !== "undefined";
    if (typeof config === "undefined" || !stripeExists) {
      throw new Error(
        `${Globals.pluginName}: Plugin configuration is missing.`
      );
    }

    if (!this.webhooks) {
      throw new Error("Stripe webhooks not found");
    }

    // throw if function is listed twice
    const functionNames = this.webhooks.map((webhook) => webhook.functionName);
    const uniqueFunctionNames = [...new Set(functionNames)];
    if (functionNames.length !== uniqueFunctionNames.length) {
      throw new Error("Function names must be unique");
    }

    // verify getSsmParameterName does not throw error
    for (const webhook of this.webhooks) {
      this.getSsmParameterName(this.getWebhookMetadata(webhook.functionName));
    }

    for (const product of this.products) {
      if (!product.name) {
        throw new Error("Product name is required");
      }
      if (!product.internal) {
        throw new Error("Product internal is required");
      }
      if (!product.internal.id) {
        throw new Error("Product internal.id is required");
      }
      if (!product.internal.description) {
        throw new Error("Product internal.description is required");
      }

      // internal id must match regex [a-zA-Z]([a-zA-Z0-9_])+]
      const regex = /^[a-zA-Z]([a-zA-Z0-9_])+$/;
      if (!regex.test(product.internal.id)) {
        throw new Error(
          `Product internal.id ${
            product.internal.id
          } does not match regex ${regex.toString()}`
        );
      }
      for (const price of product.prices) {
        if (!price.id) {
          throw new Error("Price id is required");
        }
        if (!price.price) {
          throw new Error("Price price is required");
        }
        if (!price.currency) {
          throw new Error("Price currency is required");
        }
        if (!price.countryCode) {
          throw new Error("Price countryCode is required");
        }
      }
    }
    // dont allow duplicate internal ids
    const internalIds = this.products.map((product) => product.internal.id);
    const uniqueInternalIds = [...new Set(internalIds)];
    if (internalIds.length !== uniqueInternalIds.length) {
      throw new Error("Product internal ids must be unique");
    }
  }

  private isStripeEntityManagedByThisStack(
    webhook: Pick<Stripe.WebhookEndpoint, "metadata">
  ): boolean {
    const metadata = webhook.metadata || {};
    return (
      metadata.managedBy === Globals.pluginName &&
      metadata.service === this.serverless.service.service &&
      metadata.stage === this.stage
    );
  }

  private async getWebhooksFromStripe(): Promise<Stripe.WebhookEndpoint[]> {
    const webhooks = await this.getStripe().webhookEndpoints.list();
    return webhooks.data.filter((hook) =>
      this.isStripeEntityManagedByThisStack(hook)
    );
  }

  private async getProductsFromStripe(): Promise<Stripe.Product[]> {
    const products = await this.getStripe().products.list();
    return products.data.filter((product) =>
      this.isStripeEntityManagedByThisStack(product)
    );
  }

  public async removeStripeWebhooks() {
    const webhooksBefore = await this.getWebhooksFromStripe();
    Logging.logInfo(`Removing ${webhooksBefore.length} webhooks`);

    // delete webhooks that are not in config
    const webhooksDeleted: DeletedWebhook[] = [];
    for (const webhook of webhooksBefore) {
      const deletedWebhook = await this.getStripe().webhookEndpoints.del(
        webhook.id
      );
      Logging.logInfo(`Deleted webhook ${webhook.id}`);
      webhooksDeleted.push({
        webhookId: deletedWebhook.id,
        url: webhook.url,
        lambda: webhook.metadata.lambda,
      });
    }

    this.deploymentSummary([], webhooksDeleted);
  }
  public async removeWebhooksNotInConfig() {
    const allWebhooks = await this.getWebhooksFromStripe();
    const activeWebhooks = allWebhooks.filter((w) => !w.metadata.toBeDeleted);

    const webhooksMarkedForDeletion = allWebhooks.filter(
      (w) => !activeWebhooks.some((wc) => wc.id === w.id)
    );
    Logging.logInfo(
      `Found ${webhooksMarkedForDeletion.length} webhooks that are marked for deletion`
    );

    // delete webhooks that are not in config
    const webhooksDeleted: DeletedWebhook[] = [];
    for (const webhook of webhooksMarkedForDeletion) {
      const deletedWebhook = await this.getStripe().webhookEndpoints.del(
        webhook.id
      );
      Logging.logInfo(`Deleted webhook ${webhook.id}`);
      webhooksDeleted.push({
        webhookId: deletedWebhook.id,
        url: webhook.url,
        lambda: webhook.metadata.lambda,
      });
    }

    this.deploymentSummary(activeWebhooks, webhooksDeleted);
  }

  private getWebhookUrl(webhookFunction: WebhookFunction): string {
    const { domainName, basePath } = this.customDomain;
    const httpEvent = webhookFunction.events.find(
      (e) =>
        "http" in e && typeof e.http !== "string" && e.http.method === "post"
    );

    if (!httpEvent) {
      throw new Error(
        `Function ${webhookFunction.name} does not have an HTTP POST event`
      );
    }
    const url = `https://${domainName}/${basePath}${
      (httpEvent as any).http.path
    }`;
    return url;
  }

  public async createStripeWebhooksAndProducts() {
    await this.createStripeWebhooks();
    await this.createStripeProducts();
  }

  private findMatchingPrice(
    priceConfig: StripePriceConfig,
    prices: Stripe.Price[]
  ) {
    return prices.find(
      (price) =>
        price.metadata.stage === this.stage &&
        price.metadata.service === this.serverless.service.service &&
        price.metadata.managedBy === Globals.pluginName &&
        price.metadata.country === priceConfig.countryCode &&
        price.unit_amount === priceConfig.price &&
        price.currency === priceConfig.currency &&
        price.recurring?.interval === priceConfig.interval
    );
  }

  private async createStripeProducts() {
    if (this.products.length === 0) {
      return;
    }
    const productsBefore = await this.getProductsFromStripe();
    for (const productConfig of this.products) {
      let product = productsBefore.find(
        (hook) => hook.metadata.internalId === productConfig.internal.id
      );

      const productParams = {
        name: productConfig.name,
        metadata: {
          internalId: productConfig.internal.id,
          stage: this.stage,
          service: this.serverless.service.service,
          managedBy: Globals.pluginName,
        } as ProductMetadata,
      };

      if (!product) {
        product = await this.getStripe().products.create(productParams);
        Logging.logInfo(`Created product ${product.id}`);
      } else {
        product = await this.getStripe().products.update(
          product.id,
          productParams
        );
        Logging.logInfo(`Updated webhook ${product.id}`);
      }

      const prices = await this.getStripe().prices.list({
        product: product.id,
      });

      const pricesForProduct: Stripe.Price[] = [];

      for (const priceConfig of productConfig.prices) {
        const existingPrice = this.findMatchingPrice(priceConfig, prices.data);
        if (existingPrice) {
          Logging.logInfo(`Price ${existingPrice.id} already exists`);
          pricesForProduct.push(existingPrice);
          this.serverless.service.provider.environment[priceConfig.id] =
            existingPrice.id;
          continue;
        }
        Logging.logInfo(`Creating price for ${product.id}`);

        const priceParams: Stripe.PriceCreateParams = {
          product: product.id,
          unit_amount: priceConfig.price,
          currency: priceConfig.currency,

          metadata: {
            stage: this.stage,
            service: this.serverless.service.service,
            managedBy: Globals.pluginName,
            country: priceConfig.countryCode,
          },
        };
        if (priceConfig.interval) {
          priceParams["recurring"] = {
            interval: priceConfig.interval,
          };
        }
        const price = await this.getStripe().prices.create(priceParams);
        Logging.logInfo(`Created price ${price.id}`);
        pricesForProduct.push(price);
        this.serverless.service.provider.environment[priceConfig.id] = price.id;
      }
      this.stripeProducts.push({ product, prices: pricesForProduct });
      this.serverless.service.provider.environment[productConfig.internal.id] =
        product.id;
    }
  }

  private getSsmParameterName = (metadata: WebhookMetadata) => {
    const name = `stripe-webhook-secret-${metadata.service}-${metadata.stage}-${metadata.lambda}`;
    // must match regex a-zA-Z0-9_.-
    const regex = /^[a-zA-Z0-9_.-]+$/;
    if (!regex.test(name)) {
      throw new Error(
        `Ssm parameter name ${name} does not match regex ${regex.toString()}`
      );
    }
    // Max lengt 1011 characters
    const maxTotalLength = 1011;
    const prefixLength = 80; // approx i.e. arn:aws:ssm:us-east-2:111122223333:parameter/
    const maxLength = maxTotalLength - prefixLength;
    if (name.length > maxLength) {
      throw new Error(
        `Ssm parameter name ${name} is too long, max length is 1011 characters`
      );
    }
    return name;
  };

  private getWebhookMetadata(functionName: string): WebhookMetadata {
    return {
      lambda: functionName,
      stage: this.stage,
      service: this.serverless.service.service,
      managedBy: Globals.pluginName,
    };
  }

  private async createStripeWebhooks() {
    const webhooksBefore = await this.getWebhooksFromStripe();

    const webhooksCreatedOrUpdated: Stripe.WebhookEndpoint[] = [];

    for (const webhookConfig of this.webhooks) {
      const { functionName, events, webhookSecretEnvVariableName } =
        webhookConfig;
      const webhookFunction = this.serverless.service.functions[functionName];
      if (!webhookFunction) {
        throw new Error(`Function ${functionName} not found`);
      }
      if (!events) {
        throw new Error(
          `Function ${functionName} does not have any events defined`
        );
      }
      if (!webhookSecretEnvVariableName) {
        throw new Error(`webhookSecretEnvVariableName is required`);
      }

      const webhookUrl = this.getWebhookUrl(webhookFunction);

      let webhook = webhooksBefore.find(
        (hook) => hook.metadata.lambda === functionName
      );

      const webhookParams = {
        url: webhookUrl,
        enabled_events: events,
        metadata: this.getWebhookMetadata(functionName),
      };

      const client = new SSMClient({ region: this.region });
      let createNewWebhook = !webhook;
      let webhookSecretEnvVarValue: string;
      if (!createNewWebhook) {
        try {
          const response = await client.send(
            new GetParameterCommand({
              Name: this.getSsmParameterName(webhookParams.metadata),
              WithDecryption: true,
            })
          );
          webhookSecretEnvVarValue = response.Parameter?.Value;
        } catch (e) {
          if (e.name === "ParameterNotFound") {
            createNewWebhook = true;
          } else {
            throw e;
          }
        }
        if (!webhookSecretEnvVarValue) {
          Logging.logWarning(
            `WARNING: Webhook secret not found for ${functionName} ${webhookParams.metadata.lambda}, creating webhook again.`
          );
          createNewWebhook = true;
        } else {
          await this.getStripe().webhookEndpoints.update(
            webhook.id,
            webhookParams
          );
          Logging.logInfo(`Updated webhook ${webhook.id}`);
        }
      }
      if (createNewWebhook) {
        webhook = await this.getStripe().webhookEndpoints.create(webhookParams);
        Logging.logInfo(`Created webhook ${webhook.id}`);
        if (!webhook.secret) {
          throw new Error(`Webhook ${webhook.id} secret is missing`);
        }
        await client.send(
          new PutParameterCommand({
            Name: this.getSsmParameterName(webhookParams.metadata),
            Description: `Webhook secret automatically created by ${Globals.pluginName}`,
            Value: webhook.secret,
            Type: "SecureString",
            Overwrite: true,
          })
        );
        webhookSecretEnvVarValue = webhook.secret;
      }
      webhooksCreatedOrUpdated.push(webhook);

      webhookFunction.environment = webhookFunction.environment || {};
      webhookFunction.environment[webhookSecretEnvVariableName] =
        webhookSecretEnvVarValue;
      Logging.logInfo(
        `Webhook secret: ${webhookSecretEnvVarValue} to ${functionName} varname ${webhookSecretEnvVariableName}`
      );
    }

    const webhooksToBeDeleted = webhooksBefore.filter(
      (w) => !webhooksCreatedOrUpdated.some((wc) => wc.id === w.id)
    );
    Logging.logInfo(
      `Found ${webhooksToBeDeleted.length} webhooks not in config, marking them for deletion`
    );
    // mar webhooks that are not in config for deletion
    // deletion happens after deploy
    for (const webhook of webhooksToBeDeleted) {
      await this.getStripe().webhookEndpoints.update(webhook.id, {
        metadata: {
          ...webhook.metadata,
          toBeDeleted: "true",
        },
      });
      Logging.logInfo(`Marked webhook ${webhook.id} for deletion`);
    }
  }

  public deploymentSummary(
    activeWebhooks: Stripe.WebhookEndpoint[],
    webhooksDeleted: DeletedWebhook[]
  ) {
    const TAB = "  ";
    const NEWLINE = `\n${TAB}`;
    const webhookListCreated = activeWebhooks.map((webhook) => {
      const metadata = webhook.metadata || {};
      return (
        `CREATE${NEWLINE}` +
        `webhookId:${NEWLINE}${TAB}${webhook.id}${NEWLINE}` +
        `lambda:${NEWLINE}${TAB}${metadata.lambda}${NEWLINE}` +
        `url:${NEWLINE}${TAB}${webhook.url}${NEWLINE}` +
        `events:${NEWLINE}${TAB}${webhook.enabled_events.join(
          `${NEWLINE}${TAB}`
        )}${NEWLINE}`
      );
    });

    const webhookListDeleted = webhooksDeleted.map((webhook) => {
      return (
        `DELETE${NEWLINE}` +
        `webhookId:${NEWLINE}${TAB}${webhook.webhookId}${NEWLINE}` +
        `lambda:${NEWLINE}${TAB}${webhook.lambda}${NEWLINE}` +
        `url:${NEWLINE}${TAB}${webhook.url}${NEWLINE}`
      );
    });

    // NOTE these do not get currently get printed when functions are 1st packaged and then deployed separately
    const activeProducts = this.stripeProducts.map((productEntry) => {
      return (
        `PRODUCT${NEWLINE}` +
        `productId:${NEWLINE}${TAB}${productEntry.product.id}${NEWLINE}` +
        `name:${NEWLINE}${TAB}${productEntry.product.name}${NEWLINE}` +
        `internalId:${NEWLINE}${TAB}${productEntry.product.metadata.internalId}${NEWLINE}` +
        `prices:${NEWLINE}${TAB}${productEntry.prices
          .map(
            (price) =>
              `${price.id}${NEWLINE}${TAB}${TAB}country:${price.metadata.country}${NEWLINE}${TAB}${TAB}price:${price.unit_amount}${NEWLINE}${TAB}${TAB}currency:${price.currency}${NEWLINE}${TAB}${TAB}interval:${price.recurring?.interval}`
          )
          .join(`${NEWLINE}${TAB}`)}`
      );
    });
    Globals.serverless.addServiceOutputSection(Globals.pluginName, [
      ...webhookListCreated,
      ...webhookListDeleted,
      ...activeProducts,
    ]);
  }
}

export = ServerlessStripe;
