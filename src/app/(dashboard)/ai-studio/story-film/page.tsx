import StoryFilmWorkbench from "./StoryFilmWorkbench";

export default async function StoryFilmPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <StoryFilmWorkbench initialProjectId={project ?? null} />;
}
