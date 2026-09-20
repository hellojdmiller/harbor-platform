"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
export function AdminControls({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const policy = useQuery(api.execution.policy, { workspaceId });
  const catalog = useQuery(api.ai.catalog, { workspaceId });
  const update = useMutation(api.execution.updatePolicy);
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  if (!policy || !catalog) return null;
  return (
    <section className="admin-section">
      <div className="section-heading">
        <h2>Model & spending policy</h2>
        <button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit policy"}
        </button>
      </div>
      {open && (
        <form
          className="settings-form compact"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setMessage("");
            try {
              await update({
                workspaceId,
                allowedModels: form.getAll("models").map(String),
                monthlyWorkspaceMicros: Math.round(
                  Number(form.get("workspace")) * 1e6,
                ),
                monthlyUserMicros: Math.round(Number(form.get("user")) * 1e6),
                allowEmail: form.get("email") === "on",
              });
              setMessage("Policy saved. New dispatches use these limits.");
              setOpen(false);
            } catch {
              setMessage(
                "Policy could not be saved. Check the values and your permissions.",
              );
            }
          }}
        >
          <label>
            Monthly workspace limit (USD)
            <input
              name="workspace"
              type="number"
              min="0"
              step="0.01"
              defaultValue={policy.monthlyWorkspaceMicros / 1e6}
              required
            />
          </label>
          <label>
            Monthly limit per person (USD)
            <input
              name="user"
              type="number"
              min="0"
              step="0.01"
              defaultValue={policy.monthlyUserMicros / 1e6}
              required
            />
          </label>
          <fieldset>
            <legend>Allowed models</legend>
            {catalog.models.map((m) => (
              <label className="check-label" key={m.id}>
                <input
                  type="checkbox"
                  name="models"
                  value={m.id}
                  defaultChecked={policy.allowedModels.includes(m.id)}
                />
                {m.label}
              </label>
            ))}
          </fieldset>
          <label className="check-label">
            <input
              type="checkbox"
              name="email"
              defaultChecked={policy.allowEmail}
            />{" "}
            Permit approved email delivery
          </label>
          <p className="quiet">
            Delivery still requires a configured server provider, the deployment
            write gate, and approval of the exact message.
          </p>
          <button className="primary">Save policy</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
export function RoutineControls({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const routines = useQuery(api.execution.listRoutines, { workspaceId });
  const policy = useQuery(api.execution.policy, { workspaceId });
  const create = useMutation(api.execution.createRoutine),
    toggle = useMutation(api.execution.setRoutineEnabled);
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  if (!routines || !policy) return null;
  return (
    <section className="routine-section">
      <div className="section-heading">
        <h2>Routines</h2>
        <button onClick={() => setOpen(!open)}>
          {open ? "Close" : "New routine"}
        </button>
      </div>
      {open && (
        <form
          className="settings-form compact"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              await create({
                workspaceId,
                name: String(f.get("name")),
                prompt: String(f.get("prompt")),
                model: policy.defaultModel,
                intervalMinutes: Number(f.get("interval")),
              });
              setOpen(false);
              setMessage(
                "Routine saved. Scheduled runs use your spending limits.",
              );
            } catch {
              setMessage(
                "The routine could not be saved. Check your permissions and schedule.",
              );
            }
          }}
        >
          <label>
            Name
            <input name="name" required maxLength={100} />
          </label>
          <label>
            Instructions
            <textarea name="prompt" required maxLength={12000} />
          </label>
          <label>
            Run every
            <select name="interval">
              <option value="1440">Day</option>
              <option value="10080">Week</option>
            </select>
          </label>
          <button className="primary">Create routine</button>
        </form>
      )}
      {routines.map((r) => (
        <div className="audit-row" key={r._id}>
          <span>{r.name}</span>
          <span className="quiet">{r.enabled ? "Enabled" : "Paused"}</span>
          <button
            onClick={async () => {
              try {
                await toggle({ routineId: r._id, enabled: !r.enabled });
              } catch {
                setMessage("Routine could not be changed.");
              }
            }}
          >
            {r.enabled ? "Pause" : "Enable"}
          </button>
        </div>
      ))}
      {!routines.length && !open && (
        <p className="quiet">Set up a recurring task for your assistant.</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
export function PeopleControls({
  workspaceId,
  issuer,
  owner,
}: {
  workspaceId: Id<"workspaces">;
  issuer: string;
  owner: boolean;
}) {
  const people = useQuery(api.admin.overview, { workspaceId });
  const admissions = useQuery(
    api.provisioning.list,
    owner ? { workspaceId } : "skip",
  );
  const assign = useMutation(api.provisioning.assign),
    revoke = useMutation(api.provisioning.revoke),
    change = useMutation(api.admin.setMembership);
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="admin-section">
      <div className="section-heading">
        <h2>Access controls</h2>
        <button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Manage access"}
        </button>
      </div>
      {open && (
        <>
          {owner && (
            <form
              className="settings-form compact"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                try {
                  await assign({
                    workspaceId,
                    issuer,
                    subject: String(f.get("subject")),
                    role: f.get("role") === "admin" ? "admin" : "member",
                  });
                  setMessage(
                    "Access assigned. The user’s personal assistant will be provisioned at sign-in.",
                  );
                } catch {
                  setMessage(
                    "Access could not be assigned. Check the exact identity subject and existing membership.",
                  );
                }
              }}
            >
              <label>
                Identity provider subject
                <input
                  name="subject"
                  required
                  maxLength={256}
                  placeholder="Exact user subject from your identity provider"
                />
              </label>
              <label>
                Role
                <select name="role">
                  <option value="member">Member</option>
                  <option value="admin">Administrator</option>
                </select>
              </label>
              <p className="quiet">
                This must match a verified account at your configured identity
                provider. Display names and email addresses are not used for
                identity matching.
              </p>
              <button className="primary">Provision personal assistant</button>
            </form>
          )}
          {people?.members
            .filter((m) => m.role !== "owner")
            .map((m) => (
              <div className="audit-row" key={m.id}>
                <span>{m.name}</span>
                <span className="quiet">{m.role}</span>
                <button
                  onClick={async () => {
                    try {
                      await change({
                        workspaceId,
                        membershipId: m.id,
                        role: m.role as "admin" | "member",
                        status: m.status === "active" ? "suspended" : "active",
                      });
                      setMessage("Membership updated.");
                    } catch {
                      setMessage("You cannot change this membership.");
                    }
                  }}
                >
                  {m.status === "active" ? "Suspend access" : "Restore access"}
                </button>
              </div>
            ))}
          {admissions
            ?.filter((a) => a.status === "pending")
            .map((a) => (
              <div className="audit-row" key={a._id}>
                <span>Pending: {a.subject}</span>
                <button
                  onClick={async () => {
                    try {
                      await revoke({
                        admissionId: a._id,
                        expectedRevision: a.revision,
                      });
                      setMessage("Unused admission revoked.");
                    } catch {
                      setMessage("Admission changed. Refresh and try again.");
                    }
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
