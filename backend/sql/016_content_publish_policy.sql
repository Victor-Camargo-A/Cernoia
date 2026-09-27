BEGIN;
GRANT INSERT, UPDATE ON saas.content_articles TO cernoia_app;
CREATE POLICY content_articles_integration_insert ON saas.content_articles
  FOR INSERT TO cernoia_app WITH CHECK (status = 'published');
CREATE POLICY content_articles_integration_update ON saas.content_articles
  FOR UPDATE TO cernoia_app USING (status = 'published') WITH CHECK (status = 'published');
COMMIT;
