import { useEffect, useState } from "react";
import { ChatPage } from "./pages/Chat";
import { AgentsPage } from "./pages/Agents";
import { ModelsPage } from "./pages/Models";
import { SkillsPage } from "./pages/Skills";
import { api } from "./api";

const rigLogo = new URL("../../../docs/assets/rig-logo.png", import.meta.url).href;

type Page = "chat" | "agents" | "models" | "skills";

function pageFromHash(): { page: Page; param?: string } {
  const h = location.hash.replace(/^#\/?/, "");
  const [p, param] = h.split("/");
  if (p === "agents" || p === "models" || p === "chat" || p === "skills") return { page: p, param };
  return { page: "chat" };
}

export function App() {
  const [route, setRoute] = useState(pageFromHash());
  const [health, setHealth] = useState<{ ok: boolean; secrets: string } | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(pageFromHash());
    window.addEventListener("hashchange", onHash);
    api<{ ok: boolean; secrets: string }>("/health")
      .then(setHealth)
      .catch(() => setHealth({ ok: false, secrets: "?" }));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">
          <img src={rigLogo} alt="" width="44" height="44" />
          <span>Rig</span>
        </div>
        <a className={route.page === "chat" ? "active" : ""} href="#/chat">
          Chat
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
        {route.page === "chat" && <ChatPage initialSession={route.param} />}
        {route.page === "agents" && <AgentsPage initialSlug={route.param} />}
        {route.page === "skills" && <SkillsPage initialName={route.param} />}
        {route.page === "models" && <ModelsPage />}
      </main>
    </div>
  );
}
