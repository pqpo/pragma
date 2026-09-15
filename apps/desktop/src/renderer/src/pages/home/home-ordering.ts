import type { HomeProject } from "../../../../shared/contracts/home-projects.ts";

export function previewHomeItemDragOrder(
  order: readonly string[],
  sourceId: string,
  targetId: string,
  placeAfter: boolean,
): readonly string[] {
  if (sourceId === targetId) return order;
  const sourceIndex = order.indexOf(sourceId);
  if (sourceIndex < 0 || !order.includes(targetId)) return order;
  const withoutSource = order.filter((id) => id !== sourceId);
  const targetIndex = withoutSource.indexOf(targetId);
  const next = [...withoutSource];
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId);
  return next;
}

export function orderHomeProjects(
  projects: readonly HomeProject[],
  order: readonly string[] | undefined,
): readonly HomeProject[] {
  if (
    order === undefined ||
    order.length !== projects.length ||
    new Set(order).size !== projects.length
  ) {
    return projects;
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const orderedProjects = order
    .map((id) => projectsById.get(id))
    .filter((project): project is HomeProject => project !== undefined);
  if (orderedProjects.length !== projects.length) return projects;
  if (orderedProjects.every((project, index) => project === projects[index])) return projects;
  return orderedProjects;
}
