/**
 * factory-burn-lab plugin server entry — companion Paseo plugin to
 * `paseo-factory`. Registers the `burn.*` RPC handlers (`burn.snapshot`,
 * `burn.scout`, `burn.start`, `burn.detail`, `burn.upstream.file`,
 * `burn.project.add`, `burn.supervisor.open`) while keeping all Burn Lab state
 * isolated under `<paseoHome>/burn-lab/`.
 */
import { homedir } from "node:os";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  type BurnDaemonApi,
  createBurnSurfaceHandlers,
  registerBurnSurfaceRpc,
  resolvePaseoHome,
} from "./server/surface-rpc.ts";

const PLUGIN_ID = "factory-burn-lab";
const SHELL_VERSION = "0.0.1";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

export default function contribute(server: PluginServerContext) {
  const paseoHome = resolvePaseoHome(process.env, homedir());
  let paseoApi: BurnDaemonApi | undefined;

  const capturePaseo = (context: PluginHookContext): void => {
    if (paseoApi === undefined) {
      paseoApi = context.paseo as unknown as BurnDaemonApi;
    }
  };

  const offSessionOpen = server.before("agent.session_open", (_payload, context) => {
    capturePaseo(context);
    return undefined;
  });

  const handlers = createBurnSurfaceHandlers({
    paseoHome,
    daemon: () => paseoApi,
    onLog: log,
  });

  registerBurnSurfaceRpc(server, handlers);
  log(`up v${SHELL_VERSION} — burn-lab state under ${paseoHome}/burn-lab`);

  return () => {
    offSessionOpen();
    log(`down v${SHELL_VERSION}`);
  };
}
