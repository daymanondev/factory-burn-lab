/**
 * factory-burn-lab client entry — contributes the Burn Lab screen, sidebar
 * header item (`Flame` icon), workspace panel, and settings screen.
 * Bundle boundary (no Node built-ins, no class syntax — Hermes) is enforced by
 * scripts/check-bundle.mjs.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  BurnLabPanel,
  BurnLabScreen,
  BurnLabSettings,
  BurnLabSidebarItem,
  SCREEN_ID,
} from "./client/burn-lab/entries.tsx";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "Burn Lab", Component: BurnLabScreen }),
    client.addSidebarHeaderItem({
      id: "factory-burn-lab",
      title: "Burn Lab",
      Component: BurnLabSidebarItem,
    }),
    client.addWorkspacePanel({
      id: "factory-burn-lab",
      title: "Burn Lab",
      icon: "Flame",
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: BurnLabPanel,
    }),
    client.addSettingsScreen({
      id: "factory-burn-lab",
      title: "Burn Lab",
      icon: "Flame",
      Component: BurnLabSettings,
    }),
  ];

  return () => {
    for (const off of cleanups) off();
  };
}
