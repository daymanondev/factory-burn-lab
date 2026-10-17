/**
 * Burn Lab client surface entries: global screen, workspace panel, settings
 * screen, and sidebar header item (`Flame` icon).
 */
import type {
  PluginSidebarItemProps,
  PluginSurfaceProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BurnLabShell } from "./shell.tsx";

export const SCREEN_ID = "factory-burn-lab";

export function BurnLabScreen({ theme, navigation, host }: PluginSurfaceProps) {
  return <BurnLabShell theme={theme} navigation={navigation} serverId={host.id} />;
}

export function BurnLabSettings({ theme, navigation, host }: PluginSurfaceProps) {
  return (
    <BurnLabShell
      theme={theme}
      navigation={navigation}
      serverId={host.id}
      initialTab="pool"
      showDiagnostics
    />
  );
}

export function BurnLabPanel({
  theme,
  navigation,
  host,
  workspaceId,
}: PluginWorkspacePanelProps) {
  const dir = useWorkspace(workspaceId, (workspace) => workspace.directory);
  return (
    <BurnLabShell
      theme={theme}
      dir={dir ?? undefined}
      navigation={navigation}
      serverId={host.id}
    />
  );
}

export function BurnLabSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Flame"
      label="Burn Lab"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}
