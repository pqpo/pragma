import type { Icon } from "@phosphor-icons/react";
import { CaretRight, Info, User, UsersThree, Wrench } from "@phosphor-icons/react";

import {
  collectionAssets,
  studioDescriptions,
  studioLabels,
  type ExpertRecord,
  type StudioView,
} from "./studio-model.ts";

function StudioAssetRows(props: {
  readonly assets: readonly { readonly name: string; readonly description: string }[];
  readonly icon: Icon;
}) {
  const AssetIcon = props.icon;

  return (
    <div className="studio-asset-rows">
      {props.assets.map((asset) => (
        <button className="studio-asset-row" type="button" key={asset.name}>
          <span className="studio-asset-icon" aria-hidden="true">
            <AssetIcon size={24} weight="regular" />
          </span>
          <span className="studio-asset-copy">
            <strong>{asset.name}</strong>
            <span>{asset.description}</span>
          </span>
          <CaretRight size={18} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function StudioOverviewFragment(props: {
  readonly experts: readonly ExpertRecord[];
  readonly onNavigate: (view: StudioView) => void;
}) {
  const studioAssets = {
    experts: props.experts.slice(0, 2),
    teams: collectionAssets.teams,
    tools: collectionAssets.tools,
  } satisfies Record<
    Exclude<StudioView, "overview" | "context-stores">,
    readonly { name: string; description: string }[]
  >;

  return (
    <>
      <section className="studio-overview-grid" aria-label="Studio resources">
        {(["experts", "teams", "tools"] as const).map((section) => {
          const SectionIcon =
            section === "experts" ? User : section === "teams" ? UsersThree : Wrench;

          return (
            <section className="studio-resource-section" key={section}>
              <header className="studio-resource-heading">
                <div>
                  <h2>{studioLabels[section]}</h2>
                  <p>{studioDescriptions[section]}</p>
                </div>
                <button type="button" onClick={() => props.onNavigate(section)}>
                  View all
                </button>
              </header>
              <StudioAssetRows assets={studioAssets[section]} icon={SectionIcon} />
            </section>
          );
        })}
      </section>
      <aside className="studio-relationship-note">
        <Info size={22} aria-hidden="true" />
        Teams combine experts and their tools.
      </aside>
    </>
  );
}

export function StudioCollectionFragment(props: { readonly view: "teams" | "tools" }) {
  const Icon = props.view === "teams" ? UsersThree : Wrench;

  return (
    <section className="studio-collection" aria-labelledby="studio-collection-heading">
      <header className="studio-collection-heading">
        <div>
          <h2 id="studio-collection-heading">{studioLabels[props.view]}</h2>
          <p>{studioDescriptions[props.view]}</p>
        </div>
      </header>
      <StudioAssetRows assets={collectionAssets[props.view]} icon={Icon} />
    </section>
  );
}
