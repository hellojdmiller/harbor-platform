"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
export function KnowledgeControls({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const add = useMutation(api.personalContext.add);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="knowledge-controls">
      <button onClick={() => setOpen(!open)}>
        {open ? "Close" : "Add context"}
      </button>
      {open && (
        <form
          className="settings-form compact"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            try {
              await add({
                workspaceId,
                title: String(f.get("title")),
                body: String(f.get("body")),
                useForAgent: f.get("useForAgent") === "on",
              });
              setMessage(
                "Your context is saved. You can edit its wiki page at any time.",
              );
              setOpen(false);
            } catch {
              setMessage(
                "Context could not be saved. Check its length and your workspace access.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Title
            <input name="title" required maxLength={160} />
          </label>
          <label>
            What should this page contain?
            <textarea name="body" required maxLength={2000} rows={5} />
          </label>
          <label className="check-label">
            <input name="useForAgent" type="checkbox" /> Also let my assistant
            use this information
          </label>
          <p className="quiet">
            When selected, this saves a reviewed fact with a source record.
            Editing the wiki later changes the page, not the underlying fact.
          </p>
          <button className="primary" disabled={busy}>
            Save context
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
