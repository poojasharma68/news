/**
 * "Send page to News Card Studio": for publishers that block automated access. The editor opens
 * the article in their own browser, completes any check themselves, then clicks a bookmarklet on
 * the article page. The bookmarklet reads the page's own metadata and sends it back to the
 * dashboard tab (postMessage to the opener, with the clipboard as a fallback). Nothing about the
 * publisher's check is captured or reused: only the article details a reader can see.
 */

export const IMPORT_MESSAGE_TYPE = "mu-news-import";

const LIMITS = { title: 1000, description: 10000, publisher: 300 };

/** Source of the bookmarklet. `__DASHBOARD_ORIGIN__` is replaced with the dashboard origin. */
const BOOKMARKLET_SOURCE = `(function(){
var T="__DASHBOARD_ORIGIN__";
function m(s){var e=document.querySelector(s);return e?(e.getAttribute("content")||e.getAttribute("href")||e.getAttribute("datetime")||"").trim():"";}
function abs(u){try{return u?new URL(u,location.href).href:"";}catch(e){return "";}}
function img(i){if(!i)return "";if(typeof i==="string")return i;if(Array.isArray(i))return img(i[0]);return i.url||i.contentUrl||"";}
function isOrg(o){return /Organization/i.test([].concat(o["@type"]||[]).join(" "));}
/* Largest icon in the list, skipping .ico files the server cannot decode. */
function icon(sel){var best="",size=-1;document.querySelectorAll(sel).forEach(function(e){
var h=e.getAttribute("href");if(!h||/\\.ico([?#]|$)/i.test(h))return;
var s=Math.max.apply(null,(e.getAttribute("sizes")||"0").split(/\\s+/).map(function(x){return parseInt(x,10)||0;}));
if(s>size){size=s;best=h;}});return best;}
var ld={};
document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){
try{var j=JSON.parse(s.textContent);[].concat(j&&j["@graph"]?j["@graph"]:j).forEach(function(o){
if(!o||typeof o!=="object")return;
if(!ld.date&&o.datePublished)ld.date=o.datePublished;
if(!ld.headline&&o.headline)ld.headline=o.headline;
if(!ld.description&&o.description&&!isOrg(o))ld.description=o.description;
if(!ld.publisher&&o.publisher&&o.publisher.name)ld.publisher=o.publisher.name;
if(!ld.image&&o.image&&!isOrg(o))ld.image=img(o.image);
if(!ld.logo&&o.publisher&&o.publisher.logo)ld.logo=img(o.publisher.logo);
if(!ld.orgLogo&&o.logo&&isOrg(o))ld.orgLogo=img(o.logo);
});}catch(e){}
});
var msg={type:"${IMPORT_MESSAGE_TYPE}",v:2,page:location.href,data:{
title:m('meta[property="og:title"]')||m('meta[name="twitter:title"]')||ld.headline||document.title,
description:m('meta[property="og:description"]')||m('meta[name="twitter:description"]')||ld.description||m('meta[name="description"]'),
image:abs(m('meta[property="og:image"]')||m('meta[name="twitter:image"]')||ld.image),
logo:abs(ld.logo||ld.orgLogo||icon('link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]')||icon('link[rel~="icon"]')),
published_at:m('meta[property="article:published_time"]')||ld.date||m("time[datetime]"),
publisher:m('meta[property="og:site_name"]')||ld.publisher,
url:abs(m('link[rel="canonical"]'))||location.href
}};
/* Files are downloaded here, in the reader's browser, because the server is blocked too. Image
   CDNs are other sites: a request with cookies is refused by almost all of them, so cookies are
   sent only to the article's own site. */
function grab(u){
if(!u)return Promise.resolve(null);
var own=false;try{own=new URL(u).origin===location.origin;}catch(e){}
return fetch(u,{credentials:own?"include":"omit",mode:"cors",referrerPolicy:"no-referrer-when-downgrade"})
.then(function(r){return r.ok?r.blob():null;})
.then(function(b){return b&&b.size&&/^image\\//.test(b.type)?b:null;},function(){return null;});
}
function dataUrl(b){return new Promise(function(done){if(!b)return done(null);
var fr=new FileReader();fr.onload=function(){done(fr.result);};fr.onerror=function(){done(null);};fr.readAsDataURL(b);});}
function finish(ib,lb,id,lu){
var sent=false,blobs={};if(ib)blobs.imageBlob=ib;if(lb)blobs.logoBlob=lb;
if(window.opener){try{window.opener.postMessage(Object.assign({},msg,blobs),T);sent=true;}catch(e){}}
var withData=Object.assign({},msg,id?{imageData:id}:{},lu?{logoData:lu}:{});
var missing=[];if(msg.data.image&&!ib)missing.push("image");if(msg.data.logo&&!lb)missing.push("logo");
var note=missing.length?" (the "+missing.join(" and ")+" could not be downloaded here; News Card Studio will fetch it when you save)":(ib||lb?" with the "+[ib&&"image",lb&&"logo"].filter(Boolean).join(" and "):"");
var copy=navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(JSON.stringify(withData)):Promise.reject();
copy.then(function(){
alert("Copied"+note+".\\n\\nGo back to News Card Studio. If the card did not fill in by itself, click \\"Paste page details\\".");
},function(){
if(sent)alert("Sent to News Card Studio"+note+". Switch back to the dashboard tab.");
else prompt("Copy this text and paste it into News Card Studio:",JSON.stringify(msg));
});
}
Promise.all([grab(msg.data.image),grab(msg.data.logo)]).then(function(b){
return Promise.all([dataUrl(b[0]),dataUrl(b[1])]).then(function(d){finish(b[0],b[1],d[0],d[1]);});
}).catch(function(){finish(null,null,null,null);});
})();`;

export function buildBookmarklet(dashboardOrigin) {
  const source = BOOKMARKLET_SOURCE.replace(
    "__DASHBOARD_ORIGIN__",
    dashboardOrigin,
  );
  return `javascript:${encodeURIComponent(source)}`;
}

function siteOf(hostname) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** True when two URLs/origins belong to the same site (subdomains of each other count). */
export function sameSite(a, b) {
  try {
    const x = siteOf(new URL(a).hostname);
    const y = siteOf(new URL(b).hostname);
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif)$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Logos may also be SVG; the server's logo upload accepts it and limits logos to 2 MB.
const LOGO_TYPES = /^image\/(jpeg|png|webp|gif|svg\+xml)$/;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The clipboard route carries the image as a base64 data URL. */
function dataUrlToBlob(value, maxBytes) {
  if (typeof value !== "string") return null;
  const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || (match[2].length * 3) / 4 > maxBytes) return null;
  try {
    return new Blob([Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))], {
      type: match[1],
    });
  } catch {
    return null;
  }
}

/**
 * The article image the bookmarklet downloaded in the reader's browser, as a File ready for the
 * thumbnail upload, or null. The server validates the file again.
 */
export function pageImportImage(message) {
  return toFile(
    message?.imageBlob ?? dataUrlToBlob(message?.imageData, MAX_IMAGE_BYTES),
    IMAGE_TYPES,
    MAX_IMAGE_BYTES,
    "article-image",
  );
}

/** The publisher logo the bookmarklet downloaded, as a File for the logo upload, or null. */
export function pageImportLogo(message) {
  return toFile(
    message?.logoBlob ?? dataUrlToBlob(message?.logoData, MAX_LOGO_BYTES),
    LOGO_TYPES,
    MAX_LOGO_BYTES,
    "publisher-logo",
  );
}

function toFile(blob, types, maxBytes, name) {
  if (
    typeof Blob === "undefined" ||
    !(blob instanceof Blob) ||
    !types.test(blob.type) ||
    blob.size === 0 ||
    blob.size > maxBytes
  )
    return null;
  const ext = blob.type.split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
  return new File([blob], `${name}.${ext}`, { type: blob.type });
}

/**
 * Validates data sent by the bookmarklet for the card with `sourceUrl`. Returns the usable
 * fields, or throws with a message for the editor. The page must be on the card's site.
 */
export function parsePageImport(message, sourceUrl) {
  if (
    !message ||
    typeof message !== "object" ||
    message.type !== IMPORT_MESSAGE_TYPE ||
    !message.data ||
    typeof message.data !== "object"
  ) {
    throw new Error(
      "That is not page data from the News Card Studio bookmark. Click the bookmark on the article page again.",
    );
  }
  const page = cleanUrl(message.page);
  if (!page || !sameSite(page, sourceUrl)) {
    throw new Error(
      `The page data is from ${page ? new URL(page).hostname : "an unknown page"}, not from this card's article (${new URL(sourceUrl).hostname}).`,
    );
  }

  const d = message.data;
  const date = typeof d.published_at === "string" ? new Date(d.published_at) : null;
  const url = cleanUrl(d.url);
  const fields = {
    title: cleanText(d.title, LIMITS.title),
    description: cleanText(d.description, LIMITS.description),
    publisher: cleanText(d.publisher, LIMITS.publisher),
    published_at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : "",
    original_image_url: cleanUrl(d.image),
    publisher_logo_url: cleanUrl(d.logo),
    article_url: url && sameSite(url, sourceUrl) ? url : "",
  };
  if (!Object.values(fields).some(Boolean)) {
    throw new Error(
      "No article details were found on that page. Make sure the article itself is open, not the verification page.",
    );
  }
  return fields;
}
