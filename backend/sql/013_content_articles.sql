BEGIN;
CREATE TABLE IF NOT EXISTS saas.content_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  seo_title TEXT NOT NULL,
  seo_description TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT,
  image_source TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author_label TEXT NOT NULL DEFAULT 'Equipo CernoIA',
  source_workflow TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS content_articles_published_idx ON saas.content_articles(status,published_at DESC);
ALTER TABLE saas.content_articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_articles_public_read ON saas.content_articles;
CREATE POLICY content_articles_public_read ON saas.content_articles FOR SELECT USING (status='published');
GRANT SELECT ON saas.content_articles TO cernoia_app;
COMMIT;
