"use strict";

import Globals from "./globals";
import {
  ServerlessInstance,
  ServerlessOptions,
  ServerlessUtils,
} from "./types";
import { ServerlessStripe } from "./ServerlessStripe";

class ServerlessStripePlugin {
  public hooks: object;
  private _stripeHandlers: ServerlessStripe[];

  constructor(
    serverless: ServerlessInstance,
    options: ServerlessOptions,
    v3Utils?: ServerlessUtils
  ) {
    Globals.serverless = serverless;
    Globals.options = options;
    Globals.v3Utils = v3Utils;

    this.hooks = {
      "before:package:initialize": () => this.validateConfigExists(),
      "before:package:setupProviderConfiguration": () =>
        this.createStripeWebhooksAndProducts(),
      "after:deploy:deploy": () => this.removeWebhooksNotInConfig(),
      "before:remove:remove": () => this.removeStripeWebhooks(),
    };
  }

  private getStripeHandlers() {
    if (!this._stripeHandlers) {
      this._stripeHandlers = Globals.serverless.service.custom.stripe.map(
        (config) => {
          return new ServerlessStripe(config, Globals.serverless);
        }
      );
    }
    return this._stripeHandlers;
  }

  public async validateConfigExists() {
    for (const stripeHandler of this.getStripeHandlers()) {
      stripeHandler.validateConfigExists();
    }
  }

  public async createStripeWebhooksAndProducts() {
    this.validateConfigExists();
    for (const stripeHandler of this.getStripeHandlers()) {
      await stripeHandler.createStripeWebhooksAndProducts();
    }
  }

  public async removeWebhooksNotInConfig() {
    this.validateConfigExists();
    const summary = [];
    for (const stripeHandler of this.getStripeHandlers()) {
      const output = await stripeHandler.removeWebhooksNotInConfig();
      summary.push(...output);
    }
    Globals.serverless.addServiceOutputSection(Globals.pluginName, summary);
  }

  public async removeStripeWebhooks() {
    this.validateConfigExists();
    const summary = [];
    for (const stripeHandler of this.getStripeHandlers()) {
      const output = await stripeHandler.removeStripeWebhooks();
      summary.push(...output);
    }

    Globals.serverless.addServiceOutputSection(Globals.pluginName, summary);
  }
}

export = ServerlessStripePlugin;
