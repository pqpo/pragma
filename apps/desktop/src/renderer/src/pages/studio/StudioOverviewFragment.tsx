import type { Icon } from "@phosphor-icons/react";
import { CaretRight, Database, Info, User, UsersThree, Wrench } from "@phosphor-icons/react";
import type { Capability, ContextStore } from "../../../../shared/desktop-api.ts";

import {
  studioDescriptions,
  studioLabels,
  type ExpertRecord,
  type StudioView,
} from "./studio-model.ts";

function StudioAssetRows(props: {
  readonly assets: readonly { readonly name: string; readonly description: string }[];
  readonly icon: Icon;
  readonly onOpen?: (() => void) | undefined;
}) {
  const AssetIcon = props.icon;

  return (
    <div className="studio-asset-rows">
      {props.assets.map((asset) => (
        <button className="studio-asset-row" type="button" key={asset.name} onClick={props.onOpen}>
          <span className="studio-asset-icon" aria-hidden="true">
            <AssetIcon size={24} weight="regular" />
          </span>
          <span className="studio-asset-copy">
            <strong title={asset.name}>{asset.name}</strong>
            <span title={asset.description}>{asset.description}</span>
          </span>
          <CaretRight size={18} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function StudioOverviewFragment(props: {
  readonly experts: readonly ExpertRecord[];
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly onNavigate: (view: StudioView) => void;
}) {
  const studioAssets = {
    experts: props.experts.slice(0, 2),
    teams: [],
    capabilities: props.capabilities.slice(0, 2).map((capability) => ({
      name: capability.manifest.name,
      description: capability.definition.description,
    })),
    "context-stores": props.contextStores.slice(0, 2).map((store) => ({
      name: store.name,
      description: store.description || (store.type === "file" ? "File store" : "Context note"),
    })),
  } satisfies Record<
    Exclude<StudioView, "overview">,
    readonly { name: string; description: string }[]
  >;

  return (
    <>
      <section className="studio-overview-grid" aria-label="Studio resources">
        {(["experts", "teams", "capabilities", "context-stores"] as const).map((section) => {
          const SectionIcon =
            section === "experts"
              ? User
              : section === "teams"
                ? UsersThree
                : section === "capabilities"
                  ? Wrench
                  : Database;

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
              <StudioAssetRows
                assets={studioAssets[section]}
                icon={SectionIcon}
                onOpen={() => props.onNavigate(section)}
              />
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

export function StudioCollectionFragment(props: { readonly view: "teams" }) {
  const Icon = UsersThree;

  return (
    <section className="studio-collection" aria-labelledby="studio-collection-heading">
      <header className="studio-collection-heading">
        <div>
          <h2 id="studio-collection-heading">{studioLabels[props.view]}</h2>
          <p>{studioDescriptions[props.view]}</p>
        </div>
      </header>
      <StudioAssetRows assets={[]} icon={Icon} />
    </section>
  );
}
