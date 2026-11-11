import { useEffect, useState } from "react";
import { AgentsPage } from "./pages/Agents";
import { SkillsPage } from "./pages/Skills";
import { WorkbenchPage } from "./pages/Workbench";
import { MemoryPage } from "./pages/Memory";
import { SETTINGS_SECTIONS, SettingsPage, type SettingsSection } from "./pages/Settings";
import { api } from "./api";
import { useSetup } from "./setup";

type Page = "work" | "agents" | "skills" | "memory" | "settings";

interface Health {
  ok: boolean;
  secrets: string;
  home?: string;
}

/** Pages that moved into Settings keep their old links. */
const MOVED: Record<string, SettingsSection> = { models: "models", team: "team", mcp: "mcp" };

function pageFromHash(): { page: Page; param?: string } {
  const h = location.hash.replace(/^#\/?/, "");
  const [p, param] = h.split("/");
  if (p === "agents" || p === "skills" || p === "memory") return { page: p, param };
  if (p === "settings") return { page: "settings", param: SETTINGS_SECTIONS.some((s) => s.id === param) ? param : "setup" };
  if (p && MOVED[p]) return { page: "settings", param: MOVED[p] };
  // "chat" is the pre-workbench route; old links keep working.
  if (p === "s" || p === "chat") return { page: "work", param };
  return { page: "work" };
}

export function App() {
  const [route, setRoute] = useState(pageFromHash());
  const [health, setHealth] = useState<Health | null>(null);
  const { setup, refresh } = useSetup();

  useEffect(() => {
    const onHash = () => {
      setRoute(pageFromHash());
      refresh();
    };
    window.addEventListener("hashchange", onHash);
    const check = () =>
      api<Health>("/health")
        .then(setHealth)
        .catch(() => setHealth({ ok: false, secrets: "?" }));
    check();
    const id = setInterval(check, 15_000);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(id);
    };
  }, [refresh]);

  const needsSetup = setup !== null && !setup.ready;

  return (
    <div className="app">
      <nav className="nav">
        <a className="brand" href="#/s" aria-label="Rig, sessions">
          Rig
        </a>
        <a className={route.page === "work" ? "active" : ""} href="#/s">
          Sessions
        </a>
        <a className={route.page === "agents" ? "active" : ""} href="#/agents">
          Agents
        </a>
        <a className={route.page === "skills" ? "active" : ""} href="#/skills">
          Skills
        </a>
        <a className={route.page === "memory" ? "active" : ""} href="#/memory">
          Memory
        </a>
        <div className="spacer" />
        <div className={`health ${health === null ? "" : health.ok ? "ok" : "bad"}`} title={health ? `Keys stored in: ${health.secrets}` : ""}>
          {health === null ? "connecting" : health.ok ? "runtime online" : "runtime offline"}
        </div>
        <a className={`settings-link ${route.page === "settings" ? "active" : ""}`} href={needsSetup ? "#/settings/setup" : "#/settings"}>
          Settings
          {needsSetup && <span className="badge rate_limited">set up</span>}
        </a>
      </nav>
      <main className="main">
        {route.page === "work" && <WorkbenchPage sessionId={route.param || undefined} home={health?.home} ready={setup?.ready} />}
        {route.page === "agents" && <AgentsPage initialSlug={route.param} />}
        {route.page === "skills" && <SkillsPage initialName={route.param} />}
        {route.page === "memory" && <MemoryPage />}
        {route.page === "settings" && <SettingsPage section={(route.param ?? "setup") as SettingsSection} />}
      </main>
    </div>
  );
}
