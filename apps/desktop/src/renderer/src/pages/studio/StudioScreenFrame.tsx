import type { ReactNode } from "react";

export function StudioScreenFrame(props: {
  readonly className?: string | undefined;
  readonly labelledBy?: string | undefined;
  readonly header: ReactNode;
  readonly children: ReactNode;
}) {
  const className = props.className ? `studio-screen ${props.className}` : "studio-screen";

  return (
    <section className={className} aria-labelledby={props.labelledBy}>
      <div className="studio-screen-header">{props.header}</div>
      <div className="studio-screen-body">{props.children}</div>
    </section>
  );
}
