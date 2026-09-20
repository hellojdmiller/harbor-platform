import {
  ArrowUpRight,
  Check,
  Compass,
  ShieldCheck,
  Database,
  KeyRound,
} from "lucide-react";
export function Setup() {
  return (
    <main className="setup">
      <div className="brand">
        <Compass size={30} />
        <span>Harbor</span>
        <span className="pill">Developer preview</span>
      </div>
      <div className="setup-intro">
        <h1>
          A personal assistant.
          <br />A workspace you control.
        </h1>
        <p>
          Give every person an assistant that understands their work. Give IT a
          clear view of access, approvals, and usage.
        </p>
        <a className="primary button" href="/demo">
          Explore the workspace <ArrowUpRight size={18} />
        </a>
      </div>
      <section className="setup-guide">
        <h2>Make this instance yours</h2>
        <p>
          Complete these steps to enable persistent, authenticated workspaces.
        </p>
        <ol>
          <li>
            <Database />
            <div>
              <strong>Connect Convex</strong>
              <p>
                Run <code>npm run dev:backend</code> and set the public
                deployment URL.
              </p>
            </div>
          </li>
          <li>
            <KeyRound />
            <div>
              <strong>Configure identity</strong>
              <p>
                Connect a Clerk application and configure a Convex JWT template.
                Other OIDC providers can use the same backend authorization
                model.
              </p>
            </div>
          </li>
          <li>
            <ShieldCheck />
            <div>
              <strong>Choose your providers</strong>
              <p>
                Add an Anthropic key on the Convex deployment. Review workspace
                budgets before enabling external actions.
              </p>
            </div>
          </li>
        </ol>
        <a href="https://github.com/hellojdmiller/harbor-platform#deployment">
          Open the deployment guide <ArrowUpRight size={16} />
        </a>
      </section>
      <p className="setup-foot">
        <Check size={16} /> The demo uses fictional data and sends no external
        requests.
      </p>
    </main>
  );
}
