import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';
import {addSeoRoutes,sitemapXml} from '../src/seo.js';
const pub=new URL('../public/',import.meta.url).pathname;
const html=fs.readFileSync(pub+'blog/index.html','utf8');
test('blog canonical route serves catalogue, preserves campaign query and protects stage from indexing',async()=>{
 const app=express();addSeoRoutes(app);app.use(express.static(pub));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const get=(url,host='finnikbot.ru')=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:url,headers:{host}},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,headers:new Headers(r.headers),text:async()=>Buffer.concat(chunks).toString()}));}).on('error',reject);});
 try {
  const plain=await get('/blog');assert.equal(plain.status,301);assert.equal(plain.headers.get('location'),'/blog/');
  const campaign=await get('/blog?utm_source=news');assert.equal(campaign.headers.get('location'),'/blog/?utm_source=news');
  const catalog=await get('/blog/');assert.equal(catalog.status,200);assert.match(await catalog.text(),/О деньгах —/);assert.equal(catalog.headers.get('x-robots-tag'),null);
  const stage=await get('/blog/','stage.finnikbot.ru');assert.equal(stage.status,200);assert.equal(stage.headers.get('x-robots-tag'),'noindex, nofollow');
  const links=[...html.matchAll(/class="catalog-card__link" href="([^"]+)"/g)].map(m=>m[1]);assert.equal(links.length,3);assert.equal(new Set(links).size,3);
  for(const link of links)assert.equal((await get(link)).status,200,link);
  for(const link of ['/css/blog-index.css','/js/blog.js'])assert.equal((await get(link)).status,200,link);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('catalogue metadata and images match actual existing articles, without a duplicate featured entry',()=>{
 assert.equal([...html.matchAll(/<h1\b/g)].length,1);
 assert.match(html,/<link rel="canonical" href="https:\/\/finnikbot.ru\/blog\/">/);
 const graph=JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
 assert.ok(graph.some(n=>n['@type']==='CollectionPage'));
 const list=graph.find(n=>n['@type']==='ItemList').itemListElement;assert.equal(list.length,3);
 for(const [i,item] of list.entries()) {
  assert.equal(item.position,i+1);const file=pub+new URL(item.url).pathname.slice(1)+'index.html';
  const article=fs.readFileSync(file,'utf8');assert.equal(item.name,article.match(/<h1>(.*?)<\/h1>/)[1]);
  const date=article.match(/<time datetime="([^"]+)"/)[1];assert.ok(html.includes('datetime="'+date+'"'));
 }
 for(const m of html.matchAll(/<img[^>]+src="([^"]+)"/g))assert.ok(fs.statSync(pub+m[1].slice(1)).size>0,m[1]);
 assert.ok(sitemapXml().includes('<loc>https://finnikbot.ru/blog/</loc>'));
});
