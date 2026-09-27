import { Router } from "express";
import { query } from "../db.js";
import { config } from "../config.js";
import { safeEqual } from "../security.js";

export const contentRouter = Router();
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+){2,120}$/;
function publicArticle(row) {
  return { ...row, keywords: Array.isArray(row.keywords) ? row.keywords : [] };
}
// Public metadata only: one stable URL per recurring editorial topic.
contentRouter.get("/content/seo-index", async (_req, res, next) => {
  try {
    const result = await query(`SELECT DISTINCT ON (regexp_replace(slug, '-[0-9]{4}-[0-9]{2}-[0-9]{2}$', ''))
      regexp_replace(slug, '-[0-9]{4}-[0-9]{2}-[0-9]{2}$', '') AS canonical_slug,
      slug,title,excerpt,seo_title,seo_description,image_url,published_at,author_label
      FROM saas.content_articles WHERE status='published'
      ORDER BY regexp_replace(slug, '-[0-9]{4}-[0-9]{2}-[0-9]{2}$', ''),published_at DESC,slug DESC`);
    res.set("Cache-Control", "public, max-age=60");
    res.json({ articles: result.rows });
  } catch (error) { next(error); }
});
contentRouter.get("/content/articles", async (req, res, next) => {
  try {
    const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
    const result = await query(`SELECT slug,title,excerpt,body_markdown,seo_title,seo_description,keywords,image_url,image_source,published_at,author_label
      FROM saas.content_articles WHERE status='published' ORDER BY published_at DESC LIMIT $1`, [limit]);
    res.json({ articles: result.rows.map(publicArticle) });
  } catch (error) { next(error); }
});
contentRouter.get("/content/articles/:slug", async (req, res, next) => {
  try {
    if (!slugPattern.test(req.params.slug)) return res.status(400).json({ error: "Artículo no válido." });
    const result = await query(`SELECT slug,title,excerpt,body_markdown,seo_title,seo_description,keywords,image_url,image_source,published_at,author_label
      FROM saas.content_articles WHERE slug=$1 AND status='published' LIMIT 1`, [req.params.slug]);
    if (!result.rowCount) return res.status(404).json({ error: "Artículo no encontrado." });
    res.json({ article: publicArticle(result.rows[0]) });
  } catch (error) { next(error); }
});
contentRouter.post("/integrations/content/publish", async (req, res, next) => {
  try {
    const authorization = String(req.get("authorization") ?? "");
    if (!config.n8nWebhookSecret || !safeEqual(authorization, `Bearer ${config.n8nWebhookSecret}`)) return res.status(403).json({ error: "Integración no autorizada." });
    const input = req.body ?? {};
    const fields = ["slug","title","excerpt","body_markdown","seo_title","seo_description"];
    if (fields.some(field => typeof input[field] !== "string" || !input[field].trim())) return res.status(400).json({ error: "Faltan campos editoriales." });
    if (!slugPattern.test(input.slug) || input.title.length > 150 || input.body_markdown.length > 30000 || input.seo_description.length > 180) return res.status(400).json({ error: "El artículo no cumple los límites editoriales." });
    const url = input.image_url ? new URL(String(input.image_url)) : null;
    if (url && (url.protocol !== "https:" || !["images.unsplash.com","images.pexels.com","cdn.pixabay.com"].includes(url.hostname))) return res.status(400).json({ error: "La imagen debe proceder de un banco permitido." });
    const result = await query(`INSERT INTO saas.content_articles (slug,title,excerpt,body_markdown,seo_title,seo_description,keywords,image_url,image_source,status,published_at,source_workflow,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'published',NOW(),$10,NOW())
      ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,excerpt=EXCLUDED.excerpt,body_markdown=EXCLUDED.body_markdown,seo_title=EXCLUDED.seo_title,seo_description=EXCLUDED.seo_description,keywords=EXCLUDED.keywords,image_url=EXCLUDED.image_url,image_source=EXCLUDED.image_source,status='published',published_at=NOW(),source_workflow=EXCLUDED.source_workflow,updated_at=NOW()
      RETURNING slug,title,published_at`, [input.slug.trim(),input.title.trim(),input.excerpt.trim(),input.body_markdown.trim(),input.seo_title.trim(),input.seo_description.trim(),JSON.stringify(Array.isArray(input.keywords)?input.keywords.slice(0,12):[]),url?.href ?? null,String(input.image_source ?? "").slice(0,180),String(input.source_workflow ?? "WF-CONTENT-001")]);
    res.status(201).json({ article: result.rows[0] });
  } catch (error) { next(error); }
});
