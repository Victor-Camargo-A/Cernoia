import { SITE_URL } from "@/lib/seo";
import { getArticleIndex } from "@/lib/public-articles";
const escapeXml=(text:string)=>text.replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]!));
export async function GET(){
  const articles=await getArticleIndex();
  const pages=["/","/capacidades","/como-funciona","/planes","/preguntas-frecuentes","/articulos","/licitaciones-secop","/politica-de-cambios","/politica-de-devoluciones"];
  const urls=pages.map(path=>`<url><loc>${SITE_URL}${path}</loc></url>`);
  for(const article of articles)urls.push(`<url><loc>${SITE_URL}/articulos/${escapeXml(article.canonical_slug)}</loc><lastmod>${new Date(article.published_at).toISOString()}</lastmod></url>`);
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,{headers:{"Content-Type":"application/xml; charset=utf-8","Cache-Control":"public, max-age=300"}});
}
