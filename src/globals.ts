import {
  ServerlessInstance,
  ServerlessOptions,
  ServerlessUtils,
} from "./types";

export default class Globals {
  public static pluginName = "Serverless Stripe" as const;

  public static serverless: ServerlessInstance;
  public static options: ServerlessOptions;
  public static v3Utils: ServerlessUtils;
}
