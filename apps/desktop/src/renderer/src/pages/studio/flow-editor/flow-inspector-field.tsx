import type { ReactNode } from "react";

export function InspectorField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flow-inspector-field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
