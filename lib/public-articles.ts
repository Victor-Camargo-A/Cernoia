import { cache } from "react";
import { SITE_URL } from "./seo";
export type ArticleIndex = { canonical_slug: string; slug: string; title: string; excerpt: string; seo_title: string; seo_description: string; image_url: string | null; published_at: string; author_label: string };
export type Article = ArticleIndex & { body_markdown: string; image_source: string | null };
export const canonicalArticleSlug = (slug: string) => slug.replace(/-\d{4}-\d{2}-\d{2}$/, "");
export const getArticleIndex = cache(async (): Promise<ArticleIndex[]> => {
  const response = await fetch(`${SITE_URL}/api/content/seo-index`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("No se pudo cargar el índice editorial");
  return (await response.json()).articles;
});
export const getArticle = cache(async (slug: string): Promise<Article | null> => {
  const index = await getArticleIndex();
  const item = index.find(article => article.canonical_slug === canonicalArticleSlug(slug));
  if (!item) return null;
  const response = await fetch(`${SITE_URL}/api/content/articles/${encodeURIComponent(item.slug)}`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("No se pudo cargar el artículo");
  return { ...(await response.json()).article, canonical_slug: item.canonical_slug };
});
