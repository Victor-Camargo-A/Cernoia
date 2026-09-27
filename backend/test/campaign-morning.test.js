import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignMorningOpen,campaignMail} from '../src/services/campaign-rules.js';
test('Sending window uses Colombia time: 07:00 inclusive to 19:00 exclusive',()=>{
 for(const [time,expected] of [['2026-09-16T11:59:59Z',false],['2026-09-16T12:00:00Z',true],['2026-09-16T16:59:59Z',true],['2026-09-16T17:00:00Z',true],['2026-09-16T23:59:59Z',true],['2026-09-17T00:00:00Z',false],['2026-09-17T02:00:00Z',false]]) assert.equal(campaignMorningOpen(new Date(time)),expected,time);
});
test('WhatsApp is clickable and company content remains escaped',()=>{
 const mail=campaignMail({subject:'Hola {empresa}',company_name:'<img src=x>',body_text:'Hola {empresa}\nhttps://wa.me/573207830189',cta_label:'Planes',cta_url:'https://example.com',tracking_token:'test',email:'test@example.com'}, {sender_name:'Víctor Camargo',sender_email:'owner@example.com'},'https://example.com');
 assert.ok(mail.html.includes('href="https://wa.me/573207830189"'));assert.ok(mail.html.includes('&lt;img src=x&gt;'));assert.ok(!mail.html.includes('<img src=x>'));
});
