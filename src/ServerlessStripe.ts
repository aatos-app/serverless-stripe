"use strict";

import Globals from "./globals";
import {
  ServerlessInstance,
  ServerlessOptions,
  WebhookConfig,
  CustomDomain,
  WebhookFunction,
  StripeProductConfig,
  StripePriceConfig,
  StripePortalConfig,
  SingleStripeConfig,
} from "./types";
import Logging from "./logging";
import { Stripe } from "stripe";
import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import { getAllPortalsFromStripe } from "./billingPortal";
import { getAllProductsFromStripe } from "./products";

type DeploymentSummary = string[];

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

export class ServerlessStripe {
  // Serverless specific properties
  public serverless: ServerlessInstance;
  public options: ServerlessOptions;
  public commands: object;
  public hooks: object;
  public stage: string;
  public region: string;

  // Stripe specific properties
  public accountId: string;
  private apiKey: string;
  private _stripe: Stripe;
  public webhooks: WebhookConfig[];
  public products: StripeProductConfig[];
  public billingPortals: StripePortalConfig[];

  private stripeProducts: StripeProductEntry[] = [];

  private customDomain: CustomDomain;

  constructor(
    stripeConfiguration: SingleStripeConfig,
    serverless: ServerlessInstance
  ) {
    this.serverless = serverless;
    this.webhooks = stripeConfiguration.webhooks;
    this.products = stripeConfiguration.products ?? [];
    this.billingPortals = stripeConfiguration.billingPortals ?? [];
    this.apiKey = stripeConfiguration.apiKey;
    this.accountId = stripeConfiguration.accountId;

    this.stage = this.serverless.processedInput.options.stage;
    this.region = this.serverless.service.provider.region as string;
  }

  private getStripe() {
    if (!this._stripe) {
      this._stripe = new Stripe(this.apiKey, {
        apiVersion: "2023-10-16",
      });
    }
    return this._stripe;
  }

  /**
   * Validate if the plugin config exists
   */
  public validateConfigExists(): void {
    if (!this.apiKey) {
      throw new Error(`${Globals.pluginName}: Stripe API key is required.`);
    }
    if (!this.accountId) {
      throw new Error(`${Globals.pluginName}: Stripe account ID is required.`);
    }
    if (!this.stage) {
      throw new Error(`${Globals.pluginName}: Stage is required.`);
    }
    if (!this.region) {
      throw new Error(`${Globals.pluginName}: Region is required.`);
    }
    if (typeof this.region !== "string") {
      throw new Error(`${Globals.pluginName}: Region must be a string.`);
    }

    // Make sure customDomain configuration exists, stop if not
    const config = this.serverless.service.custom;
    const stripeExists = config && typeof config.stripe !== "undefined";
    if (typeof config === "undefined" || !stripeExists) {
      throw new Error(
        `${Globals.pluginName}: Plugin configuration is missing.`
      );
    }

    this.validateWebhookConfigs();
    this.validateProductAndPriceConfigs();
    this.validatePortalConfigs();
  }

  private validatePortalConfigs() {
    for (const portal of this.billingPortals) {
      if (!portal.envVariableName) {
        throw new Error("Portal envVariableName is required");
      }
      if (!portal.configuration) {
        throw new Error("Portal configuration is required");
      }
      if (!portal.internalId) {
        throw new Error("Portal internalId is required");
      }
      // env var must match regex [a-zA-Z]([a-zA-Z0-9_])+]
      const regex = /^[a-zA-Z]([a-zA-Z0-9_])+$/;
      if (!regex.test(portal.envVariableName)) {
        throw new Error(
          `Portal envVariableName ${
            portal.envVariableName
          } does not match regex ${regex.toString()}`
        );
      }
    }
    const portalIds = this.billingPortals.map((portal) => portal.internalId);
    const uniquePortalIds = [...new Set(portalIds)];
    if (portalIds.length !== uniquePortalIds.length) {
      throw new Error("Portal ids must be unique");
    }
    const envVars = this.billingPortals.map((portal) => portal.envVariableName);
    const uniqueEnvVars = [...new Set(envVars)];
    if (envVars.length !== uniqueEnvVars.length) {
      throw new Error("Portal envVariableNames must be unique");
    }
  }

  private validateWebhookConfigs() {
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
  }

  private validateProductAndPriceConfigs() {
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
    return webhooks.data.filter((i) =>
      this.isStripeEntityManagedByThisStack(i)
    );
  }

  private async getProductsFromStripe(): Promise<Stripe.Product[]> {
    const stripe = this.getStripe();
    const products = await getAllProductsFromStripe(stripe);
    return products.filter((i) => this.isStripeEntityManagedByThisStack(i));
  }

  private async getPortalsFromStripe(): Promise<
    Stripe.BillingPortal.Configuration[]
  > {
    const stripe = this.getStripe();
    const portalConfigurations = await getAllPortalsFromStripe(stripe);
    return portalConfigurations.filter((i) =>
      this.isStripeEntityManagedByThisStack(i)
    );
  }

  public async removeStripeWebhooks(): Promise<DeploymentSummary> {
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

    return this.deploymentSummary([], webhooksDeleted);
  }
  public async removeWebhooksNotInConfig(): Promise<DeploymentSummary> {
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

    return this.deploymentSummary(activeWebhooks, webhooksDeleted);
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
    }?stripeAccountKey=${this.accountId}`;
    return url;
  }

  public async createStripeWebhooksAndProducts() {
    await this.createStripeCustomerPortals();
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
        limit: 100,
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

  private async createStripeCustomerPortals() {
    const portalsBefore = await this.getPortalsFromStripe();
    const stripe = this.getStripe();

    for (const portalConfigs of this.billingPortals) {
      const internalId = portalConfigs.internalId;
      let portal = portalsBefore.find(
        (portal) => portal.metadata.internalId === internalId
      );

      const configuration: Stripe.BillingPortal.ConfigurationCreateParams &
        Stripe.BillingPortal.ConfigurationUpdateParams = {
        ...portalConfigs.configuration,
        metadata: {
          stage: this.stage,
          service: this.serverless.service.service,
          managedBy: Globals.pluginName,
          internalId,
        },
      };
      if (portal) {
        Logging.logInfo(`Customer portal ${portal.id} already exists`);
        await stripe.billingPortal.configurations.update(
          portal.id,
          configuration
        );
      } else {
        portal = await stripe.billingPortal.configurations.create(
          configuration
        );
        Logging.logInfo(`Created customer portal ${portal.id}`);
      }
      this.serverless.service.provider.environment[
        portalConfigs.envVariableName
      ] = portal.id;
      Logging.logInfo(
        `Customer portal ${portal.id} env var ${portalConfigs.envVariableName} created`
      );
    }
  }

  private getSsmParameterName = (metadata: WebhookMetadata) => {
    const name = `stripe-webhook-secret-${this.accountId}-${metadata.service}-${metadata.stage}-${metadata.lambda}`;
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
  ): DeploymentSummary {
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
    return [
      `${NEWLINE}Stripe deployment summary for account ${this.accountId}:${NEWLINE}--------------------------------${NEWLINE}`,
      ...webhookListCreated,
      ...webhookListDeleted,
      ...activeProducts,
    ];
  }
}
