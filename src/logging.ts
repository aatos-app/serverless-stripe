import Globals from "./globals";

export default class Logging {
  public static cliLog(prefix: string, message: string): void {
    Globals.serverless.cli.log(`${prefix} ${message}`, Globals.pluginName);
  }

  public static logError(message: string): void {
    Globals.v3Utils.log.error(message);
  }

  public static logInfo(message: string): void {
    Globals.v3Utils.log.verbose(message);
  }

  public static logWarning(message: string): void {
    Globals.v3Utils.log.warning(message);
  }
}
