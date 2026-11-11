import { useEffect, useState } from "react";
import { AgentsPage } from "./pages/Agents";
import { ModelsPage } from "./pages/Models";
import { SkillsPage } from "./pages/Skills";
import { WorkbenchPage } from "./pages/Workbench";
import { api } from "./api";

type Page = "work" | "agents" | "models" | "skills";

interface Health {
  ok: boolean;
  secrets: string;
  home?: string;
}

function pageFromHash(): { page: Page; param?: string } {
  const h = location.hash.replace(/^#\/?/, "");
  const [p, param] = h.split("/");
  if (p === "agents" || p === "models" || p === "skills") return { page: p, param };
  // "chat" is the pre-workbench route; old links keep working.
  if (p === "s" || p === "chat") return { page: "work", param };
  return { page: "work" };
}

export function App() {
  const [route, setRoute] = useState(pageFromHash());
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(pageFromHash());
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
  }, []);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">Rig</div>
        <a className={route.page === "work" ? "active" : ""} href="#/s">
          Sessions
        </a>
        <a className={route.page === "agents" ? "active" : ""} href="#/agents">
          Agents
        </a>
        <a className={route.page === "skills" ? "active" : ""} href="#/skills">
          Skills
        </a>
        <a className={route.page === "models" ? "active" : ""} href="#/models">
          Models
        </a>
        <div className="spacer" />
        <div className={`health ${health?.ok ? "ok" : "bad"}`} title={health ? `secrets: ${health.secrets}` : ""}>
          {health === null ? "connecting" : health.ok ? "runtime online" : "runtime offline"}
        </div>
      </nav>
      <main className="main">
        {route.page === "work" && <WorkbenchPage sessionId={route.param || undefined} home={health?.home} />}
        {route.page === "agents" && <AgentsPage initialSlug={route.param} />}
        {route.page === "skills" && <SkillsPage initialName={route.param} />}
        {route.page === "models" && <ModelsPage />}
      </main>
    </div>
  );
}
