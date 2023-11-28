"use strict";

import Globals from "./globals";
import {
  ServerlessInstance,
  ServerlessOptions,
  ServerlessUtils,
  WebhookConfig,
  CustomDomain,
  WebhookFunction,
} from "./types";
import Logging from "./logging";
import { Stripe } from "stripe";

type WebhookMetadata = {
  lambda: string;
  stage: string;
  service: string;
  managedBy: string;
};

class ServerlessCustomDomain {
  // Serverless specific properties
  public serverless: ServerlessInstance;
  public options: ServerlessOptions;
  public commands: object;
  public hooks: object;

  // Stripe specific properties
  private _stripe: Stripe;
  public webhooks: WebhookConfig[];

  private webhooksCreated: Stripe.WebhookEndpoint[] = [];
  private webhooksDeleted: {
    webhookId: string;
    url: string;
    lambda: string;
  }[] = [];

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
    this.hooks = {
      "before:package:compileFunctions": this.hookWrapper.bind(
        this,
        this.createStripeWebhooks
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
  }

  public deploymentSummary() {
    const TAB = "  ";
    const NEWLINE = `\n${TAB}`;
    const webhookListCreated = this.webhooksCreated.map((webhook) => {
      const metadata = webhook.metadata || {};
      return `CREATE${NEWLINE}webhookId:${NEWLINE}${TAB}${
        webhook.id
      }${NEWLINE}lambda:${NEWLINE}${TAB}${
        metadata.lambda
      }${NEWLINE}url:${NEWLINE}${TAB}${
        webhook.url
      }${NEWLINE}events:${NEWLINE}${TAB}${webhook.enabled_events.join(
        `${NEWLINE}${TAB}`
      )}\n`;
    });

    const webhookListDeleted = this.webhooksDeleted.map((webhook) => {
      return `DELETE${NEWLINE}webhookId:${NEWLINE}${TAB}${webhook.webhookId}${NEWLINE}lambda:${NEWLINE}${TAB}${webhook.lambda}${NEWLINE}url:${NEWLINE}${TAB}${webhook.url}`;
    });
    Globals.serverless.addServiceOutputSection(Globals.pluginName, [
      ...webhookListCreated,
      ...webhookListDeleted,
    ]);
  }

  private isWebhookManagedByThisStack(
    webhook: Stripe.WebhookEndpoint
  ): boolean {
    const metadata = webhook.metadata || {};
    return (
      metadata.managedBy === Globals.pluginName &&
      metadata.service === this.serverless.service.service &&
      metadata.stage === this.serverless.service.provider.stage
    );
  }

  private async getWebhooksFromStripe(): Promise<Stripe.WebhookEndpoint[]> {
    const webhooks = await this.getStripe().webhookEndpoints.list();
    return webhooks.data.filter((hook) =>
      this.isWebhookManagedByThisStack(hook)
    );
  }

  public async removeStripeWebhooks() {
    const webhooksBefore = await this.getWebhooksFromStripe();
    Logging.logInfo(`Removing ${webhooksBefore.length} webhooks`);
    // delete webhooks that are not in config
    for (const webhook of webhooksBefore) {
      const deletedWebhook = await this.getStripe().webhookEndpoints.del(
        webhook.id
      );
      Logging.logInfo(`Deleted webhook ${webhook.id}`);
      this.webhooksDeleted.push({
        webhookId: deletedWebhook.id,
        url: webhook.url,
        lambda: webhook.metadata.lambda,
      });
    }

    this.deploymentSummary();
  }
  public async removeWebhooksNotInConfig() {
    const webhooksBefore = await this.getWebhooksFromStripe();
    const webhooksNotFoundInConfig = webhooksBefore.filter(
      (w) => !this.webhooksCreated.some((wc) => wc.id === w.id)
    );
    Logging.logInfo(
      `Found ${webhooksNotFoundInConfig.length} webhooks not in config`
    );
    // delete webhooks that are not in config
    for (const webhook of webhooksNotFoundInConfig) {
      const deletedWebhook = await this.getStripe().webhookEndpoints.del(
        webhook.id
      );
      Logging.logInfo(`Deleted webhook ${webhook.id}`);
      this.webhooksDeleted.push({
        webhookId: deletedWebhook.id,
        url: webhook.url,
        lambda: webhook.metadata.lambda,
      });
    }

    this.deploymentSummary();
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
    const url = `https://${domainName}/${basePath}/${
      (httpEvent as any).http.path
    }`;
    return url;
  }

  public async createStripeWebhooks() {
    const webhooksBefore = await this.getWebhooksFromStripe();
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
        metadata: {
          lambda: functionName,
          stage: this.serverless.service.provider.stage,
          service: this.serverless.service.service,
          managedBy: Globals.pluginName,
        } as WebhookMetadata,
      };

      if (!webhook) {
        webhook = await this.getStripe().webhookEndpoints.create(webhookParams);
        Logging.logInfo(`Created webhook ${webhook.id}`);
      } else {
        webhook = await this.getStripe().webhookEndpoints.update(
          webhook.id,
          webhookParams
        );
        Logging.logInfo(`Updated webhook ${webhook.id}`);
      }
      this.webhooksCreated.push(webhook);

      const webhookSecretEnvVarValue = webhook.secret;
      webhookFunction.environment = webhookFunction.environment || {};
      webhookFunction.environment[webhookSecretEnvVariableName] =
        webhookSecretEnvVarValue;
    }
  }
}

export = ServerlessCustomDomain;
