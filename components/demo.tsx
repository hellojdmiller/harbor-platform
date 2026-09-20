"use client";
import { useState } from "react";
import { demoWorkspace } from "@/lib/demo";
import { Workspace } from "./workspace";
export function Demo() {
  const [data, setData] = useState(demoWorkspace);
  return (
    <Workspace
      data={data}
      demo
      onSubmit={async () => {
        throw new Error(
          "Connect a backend and sign in to run tasks. This demo sends no requests.",
        );
      }}
      onSaveAgent={async (agent) => {
        setData({ ...data, agent });
      }}
      onSaveWiki={async (id, body) =>
        setData({
          ...data,
          wiki: data.wiki.map((p) => (p.id === id ? { ...p, body } : p)),
        })
      }
      onCancel={async () => {
        throw new Error(
          "Task actions are available in a configured workspace.",
        );
      }}
      onApprove={async () => {
        throw new Error("Approvals are available in a configured workspace.");
      }}
    />
  );
}
