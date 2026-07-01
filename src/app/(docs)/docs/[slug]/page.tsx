import { notFound } from "next/navigation";
import { getDoc, docs } from "../_content/registry";

export function generateStaticParams() {
  return docs.map((d) => ({ slug: d.meta.slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getDoc(slug);
  if (!entry) notFound();
  const { Component, meta } = entry;
  return (
    <article className="space-y-5">
      <header>
        <p className="eyebrow mb-1.5">{meta.category}</p>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "'Bai Jamjuree', sans-serif" }}>{meta.title}</h1>
      </header>
      <Component />
    </article>
  );
}
