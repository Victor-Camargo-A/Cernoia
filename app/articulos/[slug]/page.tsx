import Link from "next/link";
import { ArrowLeft, CalendarDays, ExternalLink } from "lucide-react";
import { PublicSite } from "@/app/components/public-site";
import { notFound, permanentRedirect } from "next/navigation";
import { getArticle, canonicalArticleSlug } from "@/lib/public-articles";
import { pageMetadata, SITE_URL, jsonLd } from "@/lib/seo";
export async function generateMetadata({params}:{params:Promise<{slug:string}>}) {
  const {slug}=await params; const article=await getArticle(slug);
  if(!article)return { title: "Artículo no encontrado | CernoIA", robots: { index:false, follow:true } };
  const title=article.seo_title||article.title;
  const description=article.seo_description||article.excerpt;
  const metadata=pageMetadata(`/articulos/${article.canonical_slug}`,title,description);
  return {...metadata,openGraph:{...metadata.openGraph,type:"article",publishedTime:article.published_at,...(article.image_url?{images:[article.image_url]}:{})}};
}
function renderMarkdown(markdown:string){
 const normalized=String(markdown||"").replace(/\\r\\n/g,"\n").replace(/\\n/g,"\n").replace(/\r\n/g,"\n");
 const lines=normalized.split("\n"); const blocks: {kind:string;text:string}[]=[]; let paragraph:string[]=[]; let list:string[]=[];
 const flushParagraph=()=>{if(paragraph.length){blocks.push({kind:"p",text:paragraph.join(" ").trim()});paragraph=[];}};
 const flushList=()=>{if(list.length){blocks.push({kind:"ul",text:list.join("\n")});list=[];}};
 for(const line of lines){const value=line.trim(); if(!value){flushParagraph();flushList();continue;} if(/^##\s+/.test(value)){flushParagraph();flushList();blocks.push({kind:"h2",text:value.replace(/^##\s+/,"")});continue;} if(/^###\s+/.test(value)){flushParagraph();flushList();blocks.push({kind:"h3",text:value.replace(/^###\s+/,"")});continue;} if(/^[-*]\s+/.test(value)){flushParagraph();list.push(value.replace(/^[-*]\s+/,""));continue;} flushList();paragraph.push(value); }
 flushParagraph();flushList();
 return blocks.map((block,i)=>{if(block.kind==="h2")return <h2 key={i} className="mt-10 text-2xl font-semibold tracking-tight">{block.text}</h2>; if(block.kind==="h3")return <h3 key={i} className="mt-8 text-xl font-semibold">{block.text}</h3>; if(block.kind==="ul")return <ul key={i} className="mt-5 space-y-2 leading-7 text-slate-700">{block.text.split("\n").map((item,j)=><li key={j} className="ml-5 list-disc">{item}</li>)}</ul>; return <p key={i} className="mt-5 leading-8 text-slate-700">{block.text}</p>;});
}
export default async function ArticlePage({params}:{params:Promise<{slug:string}>}) { const {slug}=await params; const article=await getArticle(slug); if(!article)notFound(); if(slug!==canonicalArticleSlug(slug))permanentRedirect(`/articulos/${article.canonical_slug}`);
 const articleSchema={"@context":"https://schema.org","@type":"Article",headline:article.title,description:article.excerpt,datePublished:article.published_at,inLanguage:"es-CO",mainEntityOfPage:SITE_URL+`/articulos/${article.canonical_slug}`,author:{"@type":"Organization",name:article.author_label||"CernoIA"},publisher:{"@type":"Organization",name:"CernoIA",url:SITE_URL},...(article.image_url?{image:article.image_url}:{})};
 return <PublicSite><script type="application/ld+json" dangerouslySetInnerHTML={{__html:jsonLd(articleSchema)}}/><article className="mx-auto max-w-4xl px-6 py-16 lg:px-10"><Link href="/articulos" className="inline-flex items-center gap-2 text-sm font-semibold text-teal-800"><ArrowLeft/> Todas las guías</Link><p className="mt-10 flex items-center gap-2 text-sm text-slate-500"><CalendarDays className="size-4"/> {new Intl.DateTimeFormat("es-CO",{dateStyle:"long"}).format(new Date(article.published_at))} · {article.author_label}</p><h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight md:text-6xl">{article.title}</h1><p className="mt-6 text-xl leading-8 text-slate-600">{article.excerpt}</p>{article.image_url&&<img src={article.image_url} alt="" className="mt-10 max-h-[28rem] w-full rounded-3xl object-cover" referrerPolicy="no-referrer" /> }<div className="prose mt-12 max-w-none">{renderMarkdown(article.body_markdown)}</div><div className="mt-12 rounded-2xl bg-[#dff1e9] p-7"><h2 className="text-2xl font-semibold">Convierte información en decisiones</h2><p className="mt-2 text-slate-700">CernoIA conecta oportunidades, requisitos y capacidades para que tu equipo revise dónde competir.</p><Link href="/planes" className="mt-5 inline-flex rounded-full bg-[#0b5963] px-5 py-3 font-semibold text-white">Ver planes y membresía</Link></div>{article.image_source&&<p className="mt-8 text-xs text-slate-500">Imagen: <a className="underline" href={article.image_source} rel="noreferrer" target="_blank">fuente del banco</a></p>}</article></PublicSite>; }
