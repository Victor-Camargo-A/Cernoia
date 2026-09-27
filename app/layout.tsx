import {MarketingTracker} from "./components/marketing-tracker";
import type { Metadata } from "next";
import "./globals.css";
import { SITE_URL, HOME_DESCRIPTION } from "@/lib/seo";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "CernoIA | Licitaciones SECOP y análisis de requisitos con IA",
  description: HOME_DESCRIPTION,
  other: {
    "google-site-verification": "RLRlb9OzySuI_KoZc-9Jwysi42m-8U0Eog0VIbRuqck",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <head>
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-Q4B02XRQC3" />
        <script dangerouslySetInnerHTML={{ __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
(function(){
var url=new URL(location.href), data={};
['cid','cmp','utm_source','utm_medium','utm_campaign'].forEach(function(k){var v=url.searchParams.get(k);if(v&&/^[a-zA-Z0-9_.-]{1,100}$/.test(v))data[k]=v;});
window.__cernoiaAttribution=data;
if(url.searchParams.has('cid')||url.searchParams.has('cmp')){url.searchParams.delete('cid');url.searchParams.delete('cmp');history.replaceState(history.state,'',url.pathname+url.search+url.hash);}
var ref='';try{var r=new URL(document.referrer);ref=r.origin+r.pathname;}catch(e){}
var cfg={page_location:location.origin+location.pathname,page_referrer:ref,allow_google_signals:false,allow_ad_personalization_signals:false};
['source','medium','campaign'].forEach(function(k){var v=data['utm_'+k];if(v)cfg[k==='campaign'?'campaign_name':'campaign_'+k]=v;});
if(!url.searchParams.has('reset_token')&&!url.searchParams.has('invite_token'))gtag('config','G-Q4B02XRQC3',cfg);
})();` }} />
      </head>
      <body className="antialiased"><MarketingTracker/>{children}</body>
    </html>
  );
}
