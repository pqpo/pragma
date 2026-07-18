import type { ReactNode } from "react";

export function SettingsScreenFrame(props: {
  readonly id: string;
  readonly labelledBy: string;
  readonly className?: string | undefined;
  readonly header: ReactNode;
  readonly children: ReactNode;
}) {
  const className = props.className
    ? `settings-panel settings-screen ${props.className}`
    : "settings-panel settings-screen";

  return (
    <section className={className} id={props.id} role="tabpanel" aria-labelledby={props.labelledBy}>
      <div className="settings-screen-header">{props.header}</div>
      <div className="settings-screen-body">{props.children}</div>
    </section>
  );
}
