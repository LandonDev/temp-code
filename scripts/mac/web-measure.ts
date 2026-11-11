/**
 * Measure Chrome AX trees, window paint, tab latency, controls, rows and load state.
 * Run on an unlocked Mac with prior AX/screen recording access; never grants access.
 * Place beside web-ax.swift, then:
 *   bun web-measure.ts --out=/private/tmp/tc-web-measure/out
 *   bun web-measure.ts --cft='/absolute/path/Google Chrome for Testing.app'
 *   bun web-measure.ts --self-test    # no app, AX walk, pointer or keys
 * Results: measurements.jsonl, findings.md, scratch pages and a few scratch PNGs.
 * Both browsers, three window states, with/without the two background flags.
 * Other Space is left unmeasured: this script never changes the user's Spaces.
 * Launch/action gate: HIDIdleTime >= 300 s; watchdog checks every second for the
 * full scratch-app lifetime. Lock/sleep ends the run. Total gate wait <= 90 min.
 * Profiles and generated helper binaries live in a unique /private/tmp run dir.
 * Never opens the personal profile, raises a personal window, or uses osascript.
 * Derived from the earlier partial macOS probe; embedded fixtures match its pages
 * except Size -> Plan/Starter/Team/Enterprise to match the requested control case.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const sleep = (ms:number) => new Promise<void>(r=>setTimeout(r,ms));
const ROOT = "/private/tmp/tc-web-measure";
const FLAGS = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
const FIXTURES:Record<string,string> = {
  "cover.html": "<!doctype html><title>Scratch cover</title><body style=\"background:#ddd;font:24px system-ui\"><h1>Scratch cover</h1>Scratch content only</body>",
  "form.html": "<!doctype html><meta charset=utf-8><title>Order form</title><style>body{font:15px system-ui;margin:32px;background:white;color:#111}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:4px}td,th{padding:8px 16px;text-align:left}td{font-variant-numeric:tabular-nums}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:850px}a{color:#0645ad}</style>\n<h1>Order form</h1><form id=f><label>Name <input id=name name=name></label><label>Email <input id=email name=email></label>\n<label>Plan <select id=plan name=plan><option>Starter</option><option>Team</option><option>Enterprise</option></select></label>\n<label><input type=checkbox id=gift> Gift wrap</label><fieldset><legend>Delivery</legend><label><input type=radio name=delivery value=Standard checked>Standard</label><label><input type=radio name=delivery value=Express>Express</label></fieldset>\n<button type=submit id=submit>Submit</button><button type=button id=probe>Probe button</button></form><p id=out role=status></p><a href=\"linked.html\">Scratch link</a><a href=\"http://127.0.0.1:18767/slow.html\">Slow local page</a><pre id=state style=\"position:fixed;bottom:0;left:32px;right:32px;max-height:100px;overflow:auto;background:white;border-top:1px solid #ccc;padding:8px;font-size:12px\"></pre>\n<script>const log=[];let clicks=0;function mirror(){state.textContent='STATE '+JSON.stringify({name:document.querySelector('#name').value,email:email.value,plan:plan.value,gift:gift.checked,delivery:document.querySelector('input[name=delivery]:checked').value,clicks,events:log});}for(const t of ['input','change','focus','click'])document.addEventListener(t,e=>{log.push(t+':'+(e.target.id||e.target.value||e.target.tagName));mirror()});probe.onclick=()=>{clicks++;document.title=\"Order form probe \"+clicks;mirror()};f.onsubmit=e=>{e.preventDefault();out.textContent='Confirmation: SCRATCH-741';document.title='Order form SCRATCH-741';mirror()};mirror();</script>",
  "report300.html": "<!doctype html><meta charset=utf-8><title>Quarterly report 300</title><style>body{font:15px system-ui;margin:32px;background:white;color:#111}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:4px}td,th{padding:8px 16px;text-align:left}td{font-variant-numeric:tabular-nums}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:850px}a{color:#0645ad}</style><h1>Quarterly report</h1><p>Scratch population by city. 300 rows.</p><p><a href=\"report300.html\">Read 300 rows</a></p><table><thead><tr><th>City</th><th>Population</th></tr></thead><tbody><tr><td>City 001</td><td>10,137</td></tr><tr><td>City 002</td><td>10,274</td></tr><tr><td>City 003</td><td>10,411</td></tr><tr><td>City 004</td><td>10,548</td></tr><tr><td>City 005</td><td>10,685</td></tr><tr><td>City 006</td><td>10,822</td></tr><tr><td>City 007</td><td>10,959</td></tr><tr><td>City 008</td><td>11,096</td></tr><tr><td>City 009</td><td>11,233</td></tr><tr><td>City 010</td><td>11,370</td></tr><tr><td>City 011</td><td>11,507</td></tr><tr><td>City 012</td><td>11,644</td></tr><tr><td>City 013</td><td>11,781</td></tr><tr><td>City 014</td><td>11,918</td></tr><tr><td>City 015</td><td>12,055</td></tr><tr><td>City 016</td><td>12,192</td></tr><tr><td>City 017</td><td>12,329</td></tr><tr><td>City 018</td><td>12,466</td></tr><tr><td>City 019</td><td>12,603</td></tr><tr><td>City 020</td><td>12,740</td></tr><tr><td>City 021</td><td>12,877</td></tr><tr><td>City 022</td><td>13,014</td></tr><tr><td>City 023</td><td>13,151</td></tr><tr><td>City 024</td><td>13,288</td></tr><tr><td>City 025</td><td>13,425</td></tr><tr><td>City 026</td><td>13,562</td></tr><tr><td>City 027</td><td>13,699</td></tr><tr><td>City 028</td><td>13,836</td></tr><tr><td>City 029</td><td>13,973</td></tr><tr><td>City 030</td><td>14,110</td></tr><tr><td>City 031</td><td>14,247</td></tr><tr><td>City 032</td><td>14,384</td></tr><tr><td>City 033</td><td>14,521</td></tr><tr><td>City 034</td><td>14,658</td></tr><tr><td>City 035</td><td>14,795</td></tr><tr><td>City 036</td><td>14,932</td></tr><tr><td>City 037</td><td>15,069</td></tr><tr><td>City 038</td><td>15,206</td></tr><tr><td>City 039</td><td>15,343</td></tr><tr><td>City 040</td><td>15,480</td></tr><tr><td>City 041</td><td>15,617</td></tr><tr><td>City 042</td><td>15,754</td></tr><tr><td>City 043</td><td>15,891</td></tr><tr><td>City 044</td><td>16,028</td></tr><tr><td>City 045</td><td>16,165</td></tr><tr><td>City 046</td><td>16,302</td></tr><tr><td>City 047</td><td>16,439</td></tr><tr><td>City 048</td><td>16,576</td></tr><tr><td>City 049</td><td>16,713</td></tr><tr><td>City 050</td><td>16,850</td></tr><tr><td>City 051</td><td>16,987</td></tr><tr><td>City 052</td><td>17,124</td></tr><tr><td>City 053</td><td>17,261</td></tr><tr><td>City 054</td><td>17,398</td></tr><tr><td>City 055</td><td>17,535</td></tr><tr><td>City 056</td><td>17,672</td></tr><tr><td>City 057</td><td>17,809</td></tr><tr><td>City 058</td><td>17,946</td></tr><tr><td>City 059</td><td>18,083</td></tr><tr><td>City 060</td><td>18,220</td></tr><tr><td>City 061</td><td>18,357</td></tr><tr><td>City 062</td><td>18,494</td></tr><tr><td>City 063</td><td>18,631</td></tr><tr><td>City 064</td><td>18,768</td></tr><tr><td>City 065</td><td>18,905</td></tr><tr><td>City 066</td><td>19,042</td></tr><tr><td>City 067</td><td>19,179</td></tr><tr><td>City 068</td><td>19,316</td></tr><tr><td>City 069</td><td>19,453</td></tr><tr><td>City 070</td><td>19,590</td></tr><tr><td>City 071</td><td>19,727</td></tr><tr><td>City 072</td><td>19,864</td></tr><tr><td>City 073</td><td>20,001</td></tr><tr><td>City 074</td><td>20,138</td></tr><tr><td>City 075</td><td>20,275</td></tr><tr><td>City 076</td><td>20,412</td></tr><tr><td>City 077</td><td>20,549</td></tr><tr><td>City 078</td><td>20,686</td></tr><tr><td>City 079</td><td>20,823</td></tr><tr><td>City 080</td><td>20,960</td></tr><tr><td>City 081</td><td>21,097</td></tr><tr><td>City 082</td><td>21,234</td></tr><tr><td>City 083</td><td>21,371</td></tr><tr><td>City 084</td><td>21,508</td></tr><tr><td>City 085</td><td>21,645</td></tr><tr><td>City 086</td><td>21,782</td></tr><tr><td>City 087</td><td>21,919</td></tr><tr><td>City 088</td><td>22,056</td></tr><tr><td>City 089</td><td>22,193</td></tr><tr><td>City 090</td><td>22,330</td></tr><tr><td>City 091</td><td>22,467</td></tr><tr><td>City 092</td><td>22,604</td></tr><tr><td>City 093</td><td>22,741</td></tr><tr><td>City 094</td><td>22,878</td></tr><tr><td>City 095</td><td>23,015</td></tr><tr><td>City 096</td><td>23,152</td></tr><tr><td>City 097</td><td>23,289</td></tr><tr><td>City 098</td><td>23,426</td></tr><tr><td>City 099</td><td>23,563</td></tr><tr><td>City 100</td><td>23,700</td></tr><tr><td>City 101</td><td>23,837</td></tr><tr><td>City 102</td><td>23,974</td></tr><tr><td>City 103</td><td>24,111</td></tr><tr><td>City 104</td><td>24,248</td></tr><tr><td>City 105</td><td>24,385</td></tr><tr><td>City 106</td><td>24,522</td></tr><tr><td>City 107</td><td>24,659</td></tr><tr><td>City 108</td><td>24,796</td></tr><tr><td>City 109</td><td>24,933</td></tr><tr><td>City 110</td><td>25,070</td></tr><tr><td>City 111</td><td>25,207</td></tr><tr><td>City 112</td><td>25,344</td></tr><tr><td>City 113</td><td>25,481</td></tr><tr><td>City 114</td><td>25,618</td></tr><tr><td>City 115</td><td>25,755</td></tr><tr><td>City 116</td><td>25,892</td></tr><tr><td>City 117</td><td>26,029</td></tr><tr><td>City 118</td><td>26,166</td></tr><tr><td>City 119</td><td>26,303</td></tr><tr><td>City 120</td><td>26,440</td></tr><tr><td>City 121</td><td>26,577</td></tr><tr><td>City 122</td><td>26,714</td></tr><tr><td>City 123</td><td>26,851</td></tr><tr><td>City 124</td><td>26,988</td></tr><tr><td>City 125</td><td>27,125</td></tr><tr><td>City 126</td><td>27,262</td></tr><tr><td>City 127</td><td>27,399</td></tr><tr><td>City 128</td><td>27,536</td></tr><tr><td>City 129</td><td>27,673</td></tr><tr><td>City 130</td><td>27,810</td></tr><tr><td>City 131</td><td>27,947</td></tr><tr><td>City 132</td><td>28,084</td></tr><tr><td>City 133</td><td>28,221</td></tr><tr><td>City 134</td><td>28,358</td></tr><tr><td>City 135</td><td>28,495</td></tr><tr><td>City 136</td><td>28,632</td></tr><tr><td>City 137</td><td>28,769</td></tr><tr><td>City 138</td><td>28,906</td></tr><tr><td>City 139</td><td>29,043</td></tr><tr><td>City 140</td><td>29,180</td></tr><tr><td>City 141</td><td>29,317</td></tr><tr><td>City 142</td><td>29,454</td></tr><tr><td>City 143</td><td>29,591</td></tr><tr><td>City 144</td><td>29,728</td></tr><tr><td>City 145</td><td>29,865</td></tr><tr><td>City 146</td><td>30,002</td></tr><tr><td>City 147</td><td>30,139</td></tr><tr><td>City 148</td><td>30,276</td></tr><tr><td>City 149</td><td>30,413</td></tr><tr><td>City 150</td><td>30,550</td></tr><tr><td>City 151</td><td>30,687</td></tr><tr><td>City 152</td><td>30,824</td></tr><tr><td>City 153</td><td>30,961</td></tr><tr><td>City 154</td><td>31,098</td></tr><tr><td>City 155</td><td>31,235</td></tr><tr><td>City 156</td><td>31,372</td></tr><tr><td>City 157</td><td>31,509</td></tr><tr><td>City 158</td><td>31,646</td></tr><tr><td>City 159</td><td>31,783</td></tr><tr><td>City 160</td><td>31,920</td></tr><tr><td>City 161</td><td>32,057</td></tr><tr><td>City 162</td><td>32,194</td></tr><tr><td>City 163</td><td>32,331</td></tr><tr><td>City 164</td><td>32,468</td></tr><tr><td>City 165</td><td>32,605</td></tr><tr><td>City 166</td><td>32,742</td></tr><tr><td>City 167</td><td>32,879</td></tr><tr><td>City 168</td><td>33,016</td></tr><tr><td>City 169</td><td>33,153</td></tr><tr><td>City 170</td><td>33,290</td></tr><tr><td>City 171</td><td>33,427</td></tr><tr><td>City 172</td><td>33,564</td></tr><tr><td>City 173</td><td>33,701</td></tr><tr><td>City 174</td><td>33,838</td></tr><tr><td>City 175</td><td>33,975</td></tr><tr><td>City 176</td><td>34,112</td></tr><tr><td>City 177</td><td>34,249</td></tr><tr><td>City 178</td><td>34,386</td></tr><tr><td>City 179</td><td>34,523</td></tr><tr><td>City 180</td><td>34,660</td></tr><tr><td>City 181</td><td>34,797</td></tr><tr><td>City 182</td><td>34,934</td></tr><tr><td>City 183</td><td>35,071</td></tr><tr><td>City 184</td><td>35,208</td></tr><tr><td>City 185</td><td>35,345</td></tr><tr><td>City 186</td><td>35,482</td></tr><tr><td>City 187</td><td>35,619</td></tr><tr><td>City 188</td><td>35,756</td></tr><tr><td>City 189</td><td>35,893</td></tr><tr><td>City 190</td><td>36,030</td></tr><tr><td>City 191</td><td>36,167</td></tr><tr><td>City 192</td><td>36,304</td></tr><tr><td>City 193</td><td>36,441</td></tr><tr><td>City 194</td><td>36,578</td></tr><tr><td>City 195</td><td>36,715</td></tr><tr><td>City 196</td><td>36,852</td></tr><tr><td>City 197</td><td>36,989</td></tr><tr><td>City 198</td><td>37,126</td></tr><tr><td>City 199</td><td>37,263</td></tr><tr><td>City 200</td><td>37,400</td></tr><tr><td>City 201</td><td>37,537</td></tr><tr><td>City 202</td><td>37,674</td></tr><tr><td>City 203</td><td>37,811</td></tr><tr><td>City 204</td><td>37,948</td></tr><tr><td>City 205</td><td>38,085</td></tr><tr><td>City 206</td><td>38,222</td></tr><tr><td>City 207</td><td>38,359</td></tr><tr><td>City 208</td><td>38,496</td></tr><tr><td>City 209</td><td>38,633</td></tr><tr><td>City 210</td><td>38,770</td></tr><tr><td>City 211</td><td>38,907</td></tr><tr><td>City 212</td><td>39,044</td></tr><tr><td>City 213</td><td>39,181</td></tr><tr><td>City 214</td><td>39,318</td></tr><tr><td>City 215</td><td>39,455</td></tr><tr><td>City 216</td><td>39,592</td></tr><tr><td>City 217</td><td>39,729</td></tr><tr><td>City 218</td><td>39,866</td></tr><tr><td>City 219</td><td>40,003</td></tr><tr><td>City 220</td><td>40,140</td></tr><tr><td>City 221</td><td>40,277</td></tr><tr><td>City 222</td><td>40,414</td></tr><tr><td>City 223</td><td>40,551</td></tr><tr><td>City 224</td><td>40,688</td></tr><tr><td>City 225</td><td>40,825</td></tr><tr><td>City 226</td><td>40,962</td></tr><tr><td>City 227</td><td>41,099</td></tr><tr><td>City 228</td><td>41,236</td></tr><tr><td>City 229</td><td>41,373</td></tr><tr><td>City 230</td><td>41,510</td></tr><tr><td>City 231</td><td>41,647</td></tr><tr><td>City 232</td><td>41,784</td></tr><tr><td>City 233</td><td>41,921</td></tr><tr><td>City 234</td><td>42,058</td></tr><tr><td>City 235</td><td>42,195</td></tr><tr><td>City 236</td><td>42,332</td></tr><tr><td>City 237</td><td>42,469</td></tr><tr><td>City 238</td><td>42,606</td></tr><tr><td>City 239</td><td>42,743</td></tr><tr><td>City 240</td><td>42,880</td></tr><tr><td>City 241</td><td>43,017</td></tr><tr><td>City 242</td><td>43,154</td></tr><tr><td>City 243</td><td>43,291</td></tr><tr><td>City 244</td><td>43,428</td></tr><tr><td>City 245</td><td>43,565</td></tr><tr><td>City 246</td><td>43,702</td></tr><tr><td>City 247</td><td>43,839</td></tr><tr><td>City 248</td><td>43,976</td></tr><tr><td>City 249</td><td>44,113</td></tr><tr><td>City 250</td><td>44,250</td></tr><tr><td>City 251</td><td>44,387</td></tr><tr><td>City 252</td><td>44,524</td></tr><tr><td>City 253</td><td>44,661</td></tr><tr><td>City 254</td><td>44,798</td></tr><tr><td>City 255</td><td>44,935</td></tr><tr><td>City 256</td><td>45,072</td></tr><tr><td>City 257</td><td>45,209</td></tr><tr><td>City 258</td><td>45,346</td></tr><tr><td>City 259</td><td>45,483</td></tr><tr><td>City 260</td><td>45,620</td></tr><tr><td>City 261</td><td>45,757</td></tr><tr><td>City 262</td><td>45,894</td></tr><tr><td>City 263</td><td>46,031</td></tr><tr><td>City 264</td><td>46,168</td></tr><tr><td>City 265</td><td>46,305</td></tr><tr><td>City 266</td><td>46,442</td></tr><tr><td>City 267</td><td>46,579</td></tr><tr><td>City 268</td><td>46,716</td></tr><tr><td>City 269</td><td>46,853</td></tr><tr><td>City 270</td><td>46,990</td></tr><tr><td>City 271</td><td>47,127</td></tr><tr><td>City 272</td><td>47,264</td></tr><tr><td>City 273</td><td>47,401</td></tr><tr><td>City 274</td><td>47,538</td></tr><tr><td>City 275</td><td>47,675</td></tr><tr><td>City 276</td><td>47,812</td></tr><tr><td>City 277</td><td>47,949</td></tr><tr><td>City 278</td><td>48,086</td></tr><tr><td>City 279</td><td>48,223</td></tr><tr><td>City 280</td><td>48,360</td></tr><tr><td>City 281</td><td>48,497</td></tr><tr><td>City 282</td><td>48,634</td></tr><tr><td>City 283</td><td>48,771</td></tr><tr><td>City 284</td><td>48,908</td></tr><tr><td>City 285</td><td>49,045</td></tr><tr><td>City 286</td><td>49,182</td></tr><tr><td>City 287</td><td>49,319</td></tr><tr><td>City 288</td><td>49,456</td></tr><tr><td>City 289</td><td>49,593</td></tr><tr><td>City 290</td><td>49,730</td></tr><tr><td>City 291</td><td>49,867</td></tr><tr><td>City 292</td><td>50,004</td></tr><tr><td>City 293</td><td>50,141</td></tr><tr><td>City 294</td><td>50,278</td></tr><tr><td>City 295</td><td>50,415</td></tr><tr><td>City 296</td><td>50,552</td></tr><tr><td>City 297</td><td>50,689</td></tr><tr><td>City 298</td><td>50,826</td></tr><tr><td>City 299</td><td>50,963</td></tr><tr><td>City 300</td><td>51,100</td></tr></tbody></table><p>END REPORT 300</p><script>window.addEventListener(\"scroll\",()=>document.title=\"Quarterly report scroll \"+Math.round(scrollY))</script>",
  "slow.html": "<!doctype html><title>Slow page</title><h1>Slow page</h1><p id=out>Waiting four seconds</p><script>setTimeout(()=>{out.textContent=\"FOUR SECOND CONTENT\"},4000)</script><script src=\"/delay.js\"></script><p>After delayed script</p>",
  "report.html": "<!doctype html><meta charset=utf-8><title>Quarterly report</title><style>body{font:15px system-ui;margin:32px;background:white;color:#111}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:4px}td,th{padding:8px 16px;text-align:left}td{font-variant-numeric:tabular-nums}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:850px}a{color:#0645ad}</style><h1>Quarterly report</h1><p>Scratch population by city. 40 rows.</p><p><a href=\"report300.html\">Read 300 rows</a></p><table><thead><tr><th>City</th><th>Population</th></tr></thead><tbody><tr><td>City 001</td><td>10,137</td></tr><tr><td>City 002</td><td>10,274</td></tr><tr><td>City 003</td><td>10,411</td></tr><tr><td>City 004</td><td>10,548</td></tr><tr><td>City 005</td><td>10,685</td></tr><tr><td>City 006</td><td>10,822</td></tr><tr><td>City 007</td><td>10,959</td></tr><tr><td>City 008</td><td>11,096</td></tr><tr><td>City 009</td><td>11,233</td></tr><tr><td>City 010</td><td>11,370</td></tr><tr><td>City 011</td><td>11,507</td></tr><tr><td>City 012</td><td>11,644</td></tr><tr><td>City 013</td><td>11,781</td></tr><tr><td>City 014</td><td>11,918</td></tr><tr><td>City 015</td><td>12,055</td></tr><tr><td>City 016</td><td>12,192</td></tr><tr><td>City 017</td><td>12,329</td></tr><tr><td>City 018</td><td>12,466</td></tr><tr><td>City 019</td><td>12,603</td></tr><tr><td>City 020</td><td>12,740</td></tr><tr><td>City 021</td><td>12,877</td></tr><tr><td>City 022</td><td>13,014</td></tr><tr><td>City 023</td><td>13,151</td></tr><tr><td>City 024</td><td>13,288</td></tr><tr><td>City 025</td><td>13,425</td></tr><tr><td>City 026</td><td>13,562</td></tr><tr><td>City 027</td><td>13,699</td></tr><tr><td>City 028</td><td>13,836</td></tr><tr><td>City 029</td><td>13,973</td></tr><tr><td>City 030</td><td>14,110</td></tr><tr><td>City 031</td><td>14,247</td></tr><tr><td>City 032</td><td>14,384</td></tr><tr><td>City 033</td><td>14,521</td></tr><tr><td>City 034</td><td>14,658</td></tr><tr><td>City 035</td><td>14,795</td></tr><tr><td>City 036</td><td>14,932</td></tr><tr><td>City 037</td><td>15,069</td></tr><tr><td>City 038</td><td>15,206</td></tr><tr><td>City 039</td><td>15,343</td></tr><tr><td>City 040</td><td>15,480</td></tr></tbody></table><p>END REPORT 40</p><script>window.addEventListener(\"scroll\",()=>document.title=\"Quarterly report scroll \"+Math.round(scrollY))</script>",
  "linked.html": "<!doctype html><title>Linked scratch page</title><h1>Linked scratch page</h1>Navigation complete"
};
type Data = Record<string, any>;
type State = "uncovered" | "covered" | "minimized";
type Row = { browser:string; state:State|"other Space"; flags:string; case:string; status:string; numbers:Data };
const args=process.argv.slice(2);
const option=(name:string)=>args.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3);
function idleFrom(text:string):number {
  if(!/^\d+$/.test(text.trim())) throw Error("HIDIdleTime unavailable; no gated step may run");
  return Number(BigInt(text.trim()))/1e9;
}
function matchesProfile(command:string,profile:string):boolean {
  return command.trim().split(/\s+/).includes(`--user-data-dir=${profile}`);
}
function safeProfile(path:string):boolean {
  return resolve(path)===path && path.startsWith(`${ROOT}/run-`) && /^profile-[\w-]+$/.test(path.split("/").at(-1)!);
}
function appBrowserPath(app:string){return `${app}/Contents/MacOS/`;}
function isTab(n:Data):boolean {return n.AXSubrole==="AXTabButton" || n.AXRole==="AXTabButton";}
function matches(n:Data,text:string):boolean {return [n.AXTitle,n.AXDescription,n.AXValue].includes(text);}
function onScreen(n:Data,area:Data):boolean|null {
  if(!Array.isArray(n.AXPosition)||!Array.isArray(n.AXSize)||!Array.isArray(area.AXPosition)||!Array.isArray(area.AXSize)) return null;
  const [x,y]=n.AXPosition, [w,h]=n.AXSize, [ax,ay]=area.AXPosition, [aw,ah]=area.AXSize;
  return x+w>ax && y+h>ay && x<ax+aw && y<ay+ah;
}
function coverage(w:Data,cover:Data):boolean {
  const a=w.bounds,b=cover.bounds;
  return cover.order<w.order && cover.layer===0 && b.X<=a.X && b.Y<=a.Y && b.X+b.Width>=a.X+a.Width && b.Y+b.Height>=a.Y+a.Height;
}
function timing(samples:Data[],title:string):Data {
  const found=(key:string,predicate:(n:Data)=>boolean)=>samples.find(s=>(s[key]??[]).some(predicate))?.elapsedMs??null;
  return {selectedMs:found("tabs",t=>t.AXTitle===title && t.AXSelected===true),
    areaMs:found("areas",a=>a.AXTitle===title),loadedMs:found("areas",a=>a.AXTitle===title && a.AXLoaded===true)};
}
class Probe {
  proc:ChildProcessWithoutNullStreams;
  waiting:{resolve:(d:Data)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
  constructor(binary:string,pid:number,profile:string) {
    this.proc=spawn(binary,[String(pid),`--profile=${profile}`],{stdio:"pipe"});
    createInterface({input:this.proc.stdout}).on("line",line=>{
      const w=this.waiting.shift();if(!w)return;clearTimeout(w.timer);
      try {w.resolve(JSON.parse(line));}catch {w.reject(Error(`bad probe JSON: ${line}`));}
    });
    const failed=()=>{for(const w of this.waiting.splice(0)){clearTimeout(w.timer);w.reject(Error("AX probe exited"));}};
    this.proc.once("error",failed);this.proc.once("exit",failed);
  }
  ask(op:string,values:Data={}):Promise<Data> {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.proc.kill();reject(Error(`AX ${op} timed out`));},30000);
      this.waiting.push({resolve,reject,timer});this.proc.stdin.write(JSON.stringify({op,...values})+"\n");
    });
  }
  close(){this.proc.stdin.end();this.proc.kill();}
}
class Halt extends Error {}
class Run {
  work:string;out:string;binary:string;log:string;rows:Row[]=[];sequence=0;
  live?:{pid:number;profile:string;probe:Probe;cover?:ReturnType<typeof spawn>;anchor?:ReturnType<typeof spawn>};
  profiles=new Set<string>();owned=new Map<number,string>();server?:Server;
  watchdog?:ReturnType<typeof setInterval>;watching=false;stopped="";waitedMs=0;shotCount=0;deadline=performance.now()+90*60*1000;cleaning?:Promise<void>;launching=false;
  constructor(out:string) {
    if(resolve(out)!==out || !new RegExp(`^${ROOT}/out(?:-[a-zA-Z0-9_-]+)?$`).test(out))throw Error("output must be a direct scratch out or out-* directory");
    mkdirSync(ROOT,{recursive:true});if(realpathSync(ROOT)!==ROOT)throw Error("scratch root must not be a symlink");
    mkdirSync(out,{recursive:true});this.out=realpathSync(out);
    if(this.out!==out)throw Error("output must not be a symlink");
    this.work=mkdtempSync(`${ROOT}/run-`);
    this.binary=join(this.work,"web-ax");this.log=join(this.out,"measurements.jsonl");
  }
  record(label:string,data:Data){appendFileSync(this.log,JSON.stringify({run:this.work.split("/").at(-1),label,wall:new Date().toISOString(),data})+"\n");}
  async compile(){
    await exec("/usr/bin/swiftc",[join(dirname(fileURLToPath(import.meta.url)),"web-ax.swift"),"-o",this.binary]);
    this.record("helper.compile",{ok:true});
  }
  async state():Promise<Data>{return JSON.parse((await exec(this.binary,["--gate"])).stdout);}
  async idle(){return idleFrom((await exec("/bin/sh",["-c","ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'"])).stdout);}
  async gate(label:string){
    while(true){
      if(this.stopped)throw new Halt(this.stopped);
      const g=await this.state();
      if(g.locked||g.displayAsleep||!g.onConsole) {this.stopped="to measure: the Mac was locked";this.record(label+".gate",g);throw new Halt(this.stopped);}
      const idle=await this.idle();
      if(idle>=300){this.record(label+".gate",{...g,idleSeconds:idle,waitedMs:this.waitedMs});return;}
      if(performance.now()>=this.deadline){this.stopped="not run: the person was at the Mac";throw new Halt(this.stopped);}
      const t=performance.now();await sleep(1000);this.waitedMs+=performance.now()-t;
    }
  }
  async processList():Promise<{pid:number;command:string}[]> {
    return (await exec("/bin/ps",["-axo","pid=,command="])).stdout.split("\n").flatMap(line=>{
      const m=line.match(/^\s*(\d+)\s+(.*)$/);return m?[{pid:Number(m[1]),command:m[2]}]:[];
    });
  }
  async track(){
    for(const p of await this.processList())for(const profile of this.profiles){
      if(matchesProfile(p.command,profile))this.owned.set(p.pid,profile);
    }
  }
  async abort(reason:string){
    if(!this.stopped){this.stopped=reason;this.record("abort",{reason});}
    await this.cleanupBrowser();
  }
  startWatch(){
    this.watchdog=setInterval(async()=>{
      if(this.watching||this.stopped)return;this.watching=true;
      try {
        const idle=await this.idle();const g=await this.state();await this.track();
        if(g.locked||g.displayAsleep||!g.onConsole)await this.abort("to measure: the Mac was locked");
        else if(idle<300)await this.abort("aborted: input resumed; remaining cases need a fresh idle gap");
      }catch(e){await this.abort(`aborted: idle watchdog failed: ${String(e)}`);}
      finally{this.watching=false;}
    },1000);
  }
  async cleanupBrowser(){
    if(this.cleaning)return this.cleaning;
    this.cleaning=this.cleanupBrowserNow();
    try{await this.cleaning;}finally{this.cleaning=undefined;}
  }
  async cleanupBrowserNow(){
    const live=this.live;
    // Use a separate helper for hide, so a long AX walk cannot hold up an abort.
    // Only processes carrying this run's exact scratch profile can be hidden.
    live?.probe.close();await this.track();
    for(const p of await this.processList()){
      const profile=this.owned.get(p.pid);
      if(profile&&matchesProfile(p.command,profile)&&!p.command.includes("--type=")){
        try{await exec(this.binary,["--hide",String(p.pid),`--profile=${profile}`],{timeout:1000});}catch{}
      }
    }
    // Never kill by app name: both a tracked pid and its unique profile must match.
    for(const p of await this.processList()){
      const profile=this.owned.get(p.pid);
      if(profile&&matchesProfile(p.command,profile)){try{process.kill(p.pid,"SIGTERM");}catch{}}
    }
    await sleep(250);
    for(const p of await this.processList()){
      const profile=this.owned.get(p.pid);
      if(profile&&matchesProfile(p.command,profile)){try{process.kill(p.pid,"SIGKILL");}catch{}}
    }
    this.live=undefined;
    if(this.launching)return; // Keep tracking the pending open request until it returns.
    // Delete only profiles from this process's unique, real /private/tmp run dir.
    for(const profile of this.profiles){
      if(!safeProfile(profile)||!profile.startsWith(this.work+"/"))throw Error("unsafe cleanup path");
      rmSync(profile,{recursive:true,force:true});
    }
    this.profiles.clear();
  }
  async launch(browser:string,state:State,flags:boolean,label:string){
    await this.gate(label);
    const profile=join(this.work,`profile-${++this.sequence}`);mkdirSync(profile);this.profiles.add(profile);
    const before=await exec(this.binary,["--gate"]); // No activation.
    const cmd=["-n","-g","-a",browser,"--args",`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--new-window","--window-position=80,80","--window-size=1000,800",...(flags?FLAGS:[]),...["form.html","report.html","report300.html"].map(x=>`${this.origin}/${x}`)];
    this.startWatch();const t=performance.now();
    this.record(label+".launch",{command:["open",...cmd],gate:JSON.parse(before.stdout)});
    await this.gate(label+".immediately-before-open");
    this.launching=true;
    await exec("/usr/bin/open",cmd);
    let pid:number|undefined;
    while(performance.now()-t<10000){
      await this.track();
      pid=(await this.processList()).find(p=>matchesProfile(p.command,profile)&&p.command.includes(appBrowserPath(browser))&&!p.command.includes("--type=")&&!p.command.includes("crashpad"))?.pid;
      if(pid)break;if(this.stopped)throw new Halt(this.stopped);await sleep(50);
    }
    if(!pid)throw Error("scratch browser pid missing");
    this.live={pid,profile,probe:new Probe(this.binary,pid,profile)};this.launching=false;
    // If the watchdog saw input during open(), clean the discovered process too.
    if(this.stopped){await this.cleanupBrowser();throw new Halt(this.stopped);}
    let nodes:Data[]=[];
    while(performance.now()-t<10000){
      nodes=(await this.read("snapshot")).nodes??[];
      if(nodes.some(n=>n.AXRole==="AXWindow"))break;await sleep(50);
    }
    if(!nodes.some(n=>n.AXRole==="AXWindow")){this.stopped="to measure: the Mac was locked";throw new Halt(this.stopped);}
    this.record(label+".initial-focus",await this.read("focus"));
    this.record(label+".after-launch-status",await this.read("status"));
    // Chrome can ignore open -g. Keep a separate, empty scratch app active so
    // covered and uncovered cases also test an inactive Chrome process.
    await this.gate(label+".anchor");
    this.live.anchor=spawn(this.binary,["--anchor","2","2","20","20",`--profile=${profile}`,`--user-data-dir=${profile}`],{stdio:"ignore"});
    await sleep(150);await this.track();
    const background=await this.read("status");
    this.record(label+".background",background);
    if(background.frontPid===pid)throw Error("scratch anchor did not make Chrome inactive");
    if(state==="covered"){
      await this.gate(label+".cover");
      const status=await this.read("status"),w=status.windows.find((w:Data)=>w.layer===0&&w.bounds.Width>200&&w.bounds.Height>200);
      if(!w)throw Error("no scratch content window");const b=w.bounds;
      this.live.cover=spawn(this.binary,["--cover",String(b.X-2),String(b.Y-2),String(b.Width+4),String(b.Height+4),`--profile=${profile}`,`--user-data-dir=${profile}`],{stdio:"ignore"});
      await sleep(150);
      const inv=await this.read("inventory");
      const own=inv.windows.find((x:Data)=>x.id===w.id),cover=inv.windows.find((x:Data)=>x.pid===this.live!.cover!.pid&&x.layer===0);
      const covered=!!own&&!!cover&&coverage(own,cover);
      this.record(label+".coverage",{covered,own,cover,frontPid:inv.frontPid});
      if(!covered)throw Error("cover did not fully cover scratch Chrome");
    }
    if(state==="minimized"){
      const window=nodes.find(n=>n.AXRole==="AXWindow")!;
      const r=await this.mutate("set",{id:window.id,attr:"AXMinimized",value:true},label+".minimize");
      if(r.error!==0||r.readback!==true)throw Error("minimize not verified");
    }
    return performance.now()-t;
  }
  origin="";
  async serve(){
    const pages=join(this.out,"pages");mkdirSync(pages,{recursive:true});
    for(const [name,html]of Object.entries(FIXTURES))writeFileSync(join(pages,name),html);
    this.server=createServer(async(req,res)=>{
      const name=(req.url??"/").slice(1).split("?")[0];
      if(name==="delay.js"){
        this.record("server.delay.start",{});await sleep(6000);
        res.writeHead(200,{"Content-Type":"text/javascript","Cache-Control":"no-store"});res.end('document.title="Slow page loaded";');this.record("server.delay.end",{});return;
      }
      const html=FIXTURES[name];if(!html){res.writeHead(404);res.end();return;}
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html.replaceAll("http://127.0.0.1:18767",this.origin));
    });
    await new Promise<void>(r=>this.server!.listen(0,"127.0.0.1",r));
    const a=this.server.address();if(!a||typeof a==="string")throw Error("no HTTP port");this.origin=`http://127.0.0.1:${a.port}`;
  }
  async read(op:string,values:Data={}){
    if(this.stopped)throw new Halt(this.stopped);
    if(!this.live)throw Error("no scratch browser");return this.live.probe.ask(op,values);
  }
  async mutate(op:string,values:Data,label:string){
    await this.gate(label);const before=await this.read("status"),t=performance.now();
    const result=await this.read(op,values);this.record(label,{result,elapsedMs:performance.now()-t,before,after:await this.read("status")});return result;
  }
  async snapshot(label:string,id?:number):Promise<Data>{const data=await this.read("snapshot",id===undefined?{}:{id});this.record(label,data);return data;}
  async tab(title:string,label:string):Promise<Data>{
    let sample=await this.read("sample");const tab=sample.tabs.find((n:Data)=>isTab(n)&&n.AXTitle===title);
    if(!tab){this.record(label,{error:"tab missing",sample});return {error:"tab missing"};}
    await this.gate(label);const before=await this.read("status"),t=performance.now();
    const action=await this.read("action",{id:tab.id,action:"AXPress"});const samples:Data[]=[];
    while(performance.now()-t<10000){
      sample=await this.read("sample");samples.push({...sample,elapsedMs:performance.now()-t});
      if(samples.at(-1)!.areas.some((a:Data)=>a.AXTitle===title&&a.AXLoaded===true))break;await sleep(20);
    }
    const after=await this.read("status");
    const result={action,alreadySelected:tab.AXSelected===true,...timing(samples,title),samples,before,after,becameFront:before.frontPid!==this.live!.pid&&after.frontPid===this.live!.pid,alreadyFront:before.frontPid===this.live!.pid};
    this.record(label,result);return result;
  }
  async shot(label:string){
    if(this.shotCount>=8)return {status:"capture limit (8)"};
    const status=await this.read("status"),sample=await this.read("sample");
    const window=status.windows.find((w:Data)=>w.layer===0&&w.bounds.Width>200&&w.bounds.Height>200),area=sample.areas[0];
    let region:number[]|undefined;
    if(window&&area&&Array.isArray(area.AXPosition)&&Array.isArray(area.AXSize))region=[area.AXPosition[0]-window.bounds.X,area.AXPosition[1]-window.bounds.Y,...area.AXSize];
    const data=await this.read("capture",{path:join(this.out,label+".png"),...(region?{region}:{})});
    if(!data.error)this.shotCount++;this.record(label+".capture",data);return data;
  }
  add(browser:string,state:State,flags:boolean,c:string,numbers:Data,status="measured"){
    this.rows.push({browser,state,flags:flags?"both":"none",case:c,status,numbers});
  }
  async c1c2(browser:string,state:State,flags:boolean,label:string){
    const c1=await this.tab("Quarterly report",label+".C1.select-unvisited");
    const pixels=await this.shot(label+".C1");
    let nodes=(await this.snapshot(label+".C1.tree")).nodes??[];
    const row=nodes.find((n:Data)=>n.AXRole==="AXRow");
    let action:Data={error:"row missing"};
    if(row)action=await this.mutate("action",{id:row.id,action:"AXScrollToVisible"},label+".C1.row-action");
    const rowAfter=row?await this.read("info",{id:row.id}):null;
    this.add(browser,state,flags,"C1",{selectedMs:c1.selectedMs,areaMs:c1.areaMs,loadedMs:c1.loadedMs,alreadySelected:c1.alreadySelected,pixels,action,rowAfter},c1.alreadySelected?"not measured: target was already selected":"measured");
    const c2=await this.tab("Order form",label+".C2");
    this.add(browser,state,flags,"C2",{selectedMs:c2.selectedMs,areaMs:c2.areaMs,loadedMs:c2.loadedMs,becameFront:c2.becameFront,alreadyFront:c2.alreadyFront,action:c2.action});
  }
  async c3(browser:string,state:State,flags:boolean,label:string){
    for(const [title,count]of [["Quarterly report",40],["Quarterly report 300",300]] as const){
      const selected=await this.tab(title,label+`.C3.${count}.select`);
      const all=(await this.snapshot(label+`.C3.${count}.app`)).nodes??[];
      const area=all.find((n:Data)=>n.AXRole==="AXWebArea"&&n.AXTitle===title);
      if(!area){this.add(browser,state,flags,"C3",{rows:count,selected,error:"web area missing"},"not measured");continue;}
      const tree=await this.snapshot(label+`.C3.${count}.walk`,area.id),nodes:Data[]=tree.nodes;
      const rows=nodes.filter(n=>n.AXRole==="AXRow"),table=nodes.find(n=>n.AXRole==="AXTable");
      const rowRead=table?await this.read("rows",{id:table.id}):{error:"table absent"};
      const last=rows.at(-1);let scroll:Data={error:"row absent"};
      if(last){scroll=await this.mutate("action",{id:last.id,action:"AXScrollToVisible"},label+`.C3.${count}.scroll`);await sleep(100);}
      const after=last?await this.read("info",{id:last.id}):{};
      const result={rows:count,walkMs:tree.ms,nodeCount:nodes.length,capped:tree.capped,rowCount:rows.length,offscreenCount:rows.filter(n=>onScreen(n,area)===false).length,frames:rows.map(n=>({id:n.id,position:n.AXPosition,size:n.AXSize})),visibleRows:table?.AXVisibleRows,visibleChildren:table?.AXVisibleChildren,areaVisibleRows:area.AXVisibleRows,areaVisibleChildren:area.AXVisibleChildren,rowRead,scroll,lastBefore:last,lastAfter:after,lastIntersectsAfter:onScreen(after,area)};
      this.record(label+`.C3.${count}.result`,result);this.add(browser,state,flags,"C3",result);
    }
  }
  async c4(browser:string,state:State,flags:boolean,label:string){
    await this.tab("Order form",label+".C4.select");
    let nodes:Data[]=(await this.snapshot(label+".C4.before")).nodes;
    const control=(role:string,text:string)=>nodes.find(n=>n.AXRole===role&&matches(n,text));
    const results:Data={initialFocus:await this.read("focus")};
    const act=async(name:string,op:string,values:Data)=>{
      const before=await this.read("snapshot");const result=await this.mutate(op,values,label+".C4."+name);await sleep(100);
      const after=await this.snapshot(label+".C4."+name+".after");nodes=after.nodes;
      results[name]={result,beforeState:before.nodes.filter((n:Data)=>typeof n.AXValue==="string"&&n.AXValue.startsWith("STATE ")),afterState:nodes.filter(n=>typeof n.AXValue==="string"&&n.AXValue.startsWith("STATE ")),focus:await this.read("focus"),frontStatus:await this.read("status"),fields:nodes.filter(n=>["AXTextField","AXComboBox"].includes(n.AXRole)),readback:values.id===undefined?null:await this.read("info",{id:values.id})};
    };
    const name=control("AXTextField","Name"),select=control("AXPopUpButton","Plan"),check=control("AXCheckBox","Gift wrap"),button=control("AXButton","Probe button");
    if(button)await act("button","action",{id:button.id,action:"AXPress"});else results.button={error:"button absent"};
    if(check)await act("checkbox","action",{id:check.id,action:"AXPress"});else results.checkbox={error:"checkbox absent"};
    if(name){
      await act("textValue","set",{id:name.id,attr:"AXValue",value:"Scratch Alpha"});
      await act("focusField","set",{id:name.id,attr:"AXFocused",value:true});
      await act("pidKey","key",{text:"Z"});
    }else results.textValue={error:"text field absent"};
    if(select){
      await act("selectValue","set",{id:select.id,attr:"AXValue",value:"Team"});
      await act("selectOpen","action",{id:select.id,action:"AXPress"});
      results.menuAppeared=nodes.some(n=>n.AXRole==="AXMenu");
      let item=control("AXMenuItem","Team");
      if(item)await act("selectItemPress","action",{id:item.id,action:"AXPress"});else results.selectItemPress={error:"Team item absent"};
      await act("selectReopen","action",{id:select.id,action:"AXPress"});item=control("AXMenuItem","Enterprise");
      if(item)await act("selectItemPick","action",{id:item.id,action:"AXPick"});else results.selectItemPick={error:"Enterprise item absent"};
      const menu=nodes.find(n=>n.AXRole==="AXMenu");
      if(menu)await act("menuCancel","action",{id:menu.id,action:"AXCancel"});
      if(nodes.some(n=>n.AXRole==="AXMenu"))await act("menuEscape","key",{code:53});
      results.finalSelect=await this.read("info",{id:select.id});
    }else results.selectValue={error:"Plan select absent"};
    await this.shot(label+".C4");
    const link=control("AXLink","Scratch link");if(link)await act("link","action",{id:link.id,action:"AXPress"});else results.link={error:"link absent"};
    results.finalStatus=await this.read("status");
    this.add(browser,state,flags,"C4",results);this.record(label+".C4.result",results);
  }
  async c5(browser:string,state:State,flags:boolean,label:string){
    // Subscribe before visiting slow.html so LoadComplete is not already past.
    const all=await this.snapshot(label+".C5.initial");
    for(const n of [{id:0},...all.nodes.filter((n:Data)=>["AXWindow","AXWebArea"].includes(n.AXRole))])this.record(label+".C5.subscribe",await this.read("subscribe",{id:n.id}));
    await this.tab("Order form",label+".C5.form");
    const nodes=(await this.read("snapshot")).nodes;
    const link=nodes.find((n:Data)=>n.AXRole==="AXLink"&&matches(n,"Slow local page"));
    if(!link){this.add(browser,state,flags,"C5",{error:"slow link absent"},"not measured");return;}
    await this.gate(label+".C5.navigate");const t=performance.now();
    const action=await this.read("action",{id:link.id,action:"AXPress"});const samples:Data[]=[],subscribed=new Set<number>();
    while(performance.now()-t<9000){
      const sample=await this.read("sample");
      for(const a of sample.areas)if(!subscribed.has(a.id)){subscribed.add(a.id);this.record(label+".C5.subscribe-area",await this.read("subscribe",{id:a.id}));}
      samples.push({...sample,elapsedMs:performance.now()-t,notes:await this.read("poll",{seconds:0.01})});await sleep(50);
    }
    const result={action,samples,firstLoadedMs:samples.find(s=>s.areas.some((a:Data)=>String(a.AXTitle).startsWith("Slow page")&&a.AXLoaded===true))?.elapsedMs??null,loadComplete:samples.flatMap(s=>s.notes.notes??[]).filter(n=>n.name==="AXLoadComplete").map(n=>({...n,fromNavigationMs:n.ms-(action.atMs-action.ms)}))};
    this.add(browser,state,flags,"C5",result);this.record(label+".C5.result",result);
  }
  report(reason:string){
    for(const browser of ["Chrome for Testing","Installed Chrome"])for(const state of ["uncovered","covered","minimized","other Space"] as const)for(const flags of ["none","both"])for(const c of ["C1","C2","C3","C4","C5"]){
      if(!this.rows.some(r=>r.browser===browser&&r.state===state&&r.flags===flags&&r.case===c))this.rows.push({browser,state,flags,case:c,status:state==="other Space"?"not run: no Space change attempted":reason,numbers:{}});
    }
    let text="# Chrome AX and paint measurements\n\n"+new Date().toISOString()+". This run uses isolated scratch profiles. See measurements.jsonl for raw data.\n\n";
    const columns:Record<string,[string,(n:Data)=>any][]>={
      C1:[["AXSelected ms",n=>n.selectedMs],["WebArea ms",n=>n.areaMs],["AXLoaded ms",n=>n.loadedMs],["White body fraction",n=>n.pixels?.bodyWhiteFraction],["AX action error",n=>n.action?.error]],
      C2:[["AXSelected ms",n=>n.selectedMs],["WebArea ms",n=>n.areaMs],["AXLoaded ms",n=>n.loadedMs],["Became front",n=>n.becameFront],["Already front",n=>n.alreadyFront]],
      C3:[["Fixture rows",n=>n.rows],["Walk ms",n=>n.walkMs],["Tree rows",n=>n.rowCount],["Offscreen rows",n=>n.offscreenCount],["Scroll error",n=>n.scroll?.error],["Last row visible after",n=>n.lastIntersectsAfter]],
      C4:[["Text readback",n=>n.textValue?.readback?.AXValue],["Select set readback",n=>n.selectValue?.readback?.AXValue],["Menu appeared",n=>n.menuAppeared],["Item AXPress error",n=>n.selectItemPress?.result?.error],["Item AXPick error",n=>n.selectItemPick?.result?.error],["Select final",n=>n.finalSelect?.AXValue]],
      C5:[["First AXLoaded ms",n=>n.firstLoadedMs],["LoadComplete count",n=>n.loadComplete?.length],["First LoadComplete ms",n=>n.loadComplete?.[0]?.fromNavigationMs]]
    };
    const cell=(value:any)=>value===undefined||value===null?"—":String(typeof value==="object"?JSON.stringify(value):value).replaceAll("|","\\|").replaceAll("\n"," ");
    for(const c of ["C1","C2","C3","C4","C5"]){
      const cols=columns[c];
      text+=`## ${c}\n\n| Browser | State | Flags | Status | ${cols.map(x=>x[0]).join(" | ")} |\n|---|---|---|---|${cols.map(()=>"---").join("|")}|\n`;
      for(const r of this.rows.filter(r=>r.case===c))text+=`| ${r.browser} | ${r.state} | ${r.flags} | ${r.status} | ${cols.map(x=>cell(x[1](r.numbers))).join(" | ")} |\n`;
      text+="\n";
    }
    text+='## C6\n\nMac thread vs box thread: not run here; covered by the field hand run\n\n## What this means for §25\n\n- Covered tree creation: use C1 areaMs and the coverage record; null is no observation, not zero.\n- Select AXValue: use C4 selectValue readback; the AX error alone does not prove a change.\n- Background pick: use C4 selectItemPick readback and frontPid; a cover alone does not make the app inactive.\n- Keys: compare C4 focus chain, field/omnibox readbacks and state mirror; pid posting does not imply field focus.\n- Timing uses monotonic clocks. First-seen times are upper bounds at the recorded polling cadence. Screenshot capture can cause rendering.\n';
    writeFileSync(join(this.out,"findings.md"),text);
  }
  async cleanup(){
    if(this.watchdog)clearInterval(this.watchdog);this.watchdog=undefined;
    await this.cleanupBrowser();this.server?.closeAllConnections();await new Promise<void>(r=>this.server?this.server.close(()=>r()):r());
    rmSync(this.work,{recursive:true,force:true});this.record("cleanup",{profilesRemaining:0,workRemoved:!existsSync(this.work)});
  }
}
async function selfTest(){
  let count=0;const test=(name:string,f:()=>void)=>{f();count++;console.log(`ok ${count} - ${name}`);};
  test("idle conversion and exact five-minute boundary",()=>{assert.equal(idleFrom("300000000000\n"),300);assert.ok(idleFrom("299999999999")<300);});
  test("missing and malformed idle fail closed",()=>{for(const v of ["","nan","-1","17x"])assert.throws(()=>idleFrom(v));});
  test("kill guard matches the whole profile argument",()=>{const p=ROOT+"/run-test/profile-1";assert.ok(matchesProfile(`chrome --user-data-dir=${p}`,p));for(const cmd of [`chrome --user-data-dir=${p}0`,`chrome ${p}`,"chrome"])assert.ok(!matchesProfile(cmd,p));});
  test("cleanup path stays in scratch",()=>{assert.ok(safeProfile(ROOT+"/run-test/profile-1"));for(const p of [ROOT+"/run-test/../profile-1","/Users/user/profile-1",ROOT+"/profile-1"])assert.ok(!safeProfile(p));});
  test("tabs match role or subrole, not all radio buttons",()=>{assert.ok(isTab({AXRole:"AXRadioButton",AXSubrole:"AXTabButton"}));assert.ok(isTab({AXRole:"AXTabButton"}));assert.ok(!isTab({AXRole:"AXRadioButton"}));});
  test("selected, tree and loaded clocks stay separate",()=>{assert.deepEqual(timing([{elapsedMs:10,tabs:[{AXTitle:"X",AXSelected:true}]},{elapsedMs:20,areas:[{AXTitle:"X",AXLoaded:false}]},{elapsedMs:30,areas:[{AXTitle:"X",AXLoaded:true}]}],"X"),{selectedMs:10,areaMs:20,loadedMs:30});assert.equal(timing([],"X").loadedMs,null);});
  test("offscreen frames and unknown geometry",()=>{const area={AXPosition:[0,0],AXSize:[100,100]};assert.equal(onScreen({AXPosition:[0,200],AXSize:[20,20]},area),false);assert.equal(onScreen({AXPosition:[0,99],AXSize:[20,20]},area),true);assert.equal(onScreen({},area),null);});
  test("cover must be in front and contain the full frame",()=>{const w={order:2,bounds:{X:10,Y:10,Width:100,Height:100}};assert.ok(coverage(w,{order:1,layer:0,bounds:{X:0,Y:0,Width:120,Height:120}}));assert.ok(!coverage(w,{order:3,layer:0,bounds:{X:0,Y:0,Width:120,Height:120}}));});
  test("fixtures have Plan and exact report row counts",()=>{assert.match(FIXTURES["form.html"],/Plan <select id=plan/);assert.match(FIXTURES["form.html"],/<option>Team<\/option>/);assert.equal((FIXTURES["report.html"].match(/<tr>/g)??[]).length,41);assert.equal((FIXTURES["report300.html"].match(/<tr>/g)??[]).length,301);});
  test("slow page keeps the delayed external script",()=>assert.match(FIXTURES["slow.html"],/src="\/delay.js"/));
  const run=new Run(ROOT+"/out-selftest-"+process.pid+"-"+Date.now());
  const recorded:{label:string;data:Data}[]=[];
  run.record=(label,data)=>recorded.push({label,data});
  try{
    const savedState=run.state,savedIdle=run.idle;
    run.state=async()=>({locked:true,onConsole:true,displayAsleep:false});run.idle=async()=>{throw Error("idle should not be read after lock");};
    await assert.rejects(()=>run.gate("test.lock"),/Mac was locked/);count++;console.log(`ok ${count} - locked session ends gate before any launch or idle read`);
    run.stopped="";run.state=async()=>({locked:false,onConsole:true,displayAsleep:false});run.idle=async()=>300;
    await run.gate("test.idle");assert.equal(run.waitedMs,0);count++;console.log(`ok ${count} - idle boundary admits without waiting`);
    run.deadline=performance.now()-1;run.idle=async()=>299;
    await assert.rejects(()=>run.gate("test.expired"),/person was at the Mac/);count++;console.log(`ok ${count} - deadline ends wait without launching`);
    run.stopped="";run.idle=async()=>299;run.state=async()=>({locked:false,onConsole:true,displayAsleep:false});
    const savedCleanup=run.cleanupBrowser,savedTrack=run.track;let cleanupCalls=0;
    run.cleanupBrowser=async()=>{cleanupCalls++;};run.track=async()=>{};
    run.startWatch();await sleep(1150);clearInterval(run.watchdog);
    assert.match(run.stopped,/input resumed/);assert.equal(cleanupCalls,1);count++;console.log(`ok ${count} - one-second watchdog aborts and cleans on resumed input`);
    run.stopped="";cleanupCalls=0;run.idle=async()=>500;run.state=async()=>({locked:true,onConsole:true,displayAsleep:false});
    run.startWatch();await sleep(1150);clearInterval(run.watchdog);
    assert.match(run.stopped,/Mac was locked/);assert.equal(cleanupCalls,1);count++;console.log(`ok ${count} - watchdog stops on lock even when idle`);
    run.cleanupBrowser=savedCleanup;run.track=savedTrack;
    run.state=savedState;run.idle=savedIdle;run.stopped="";
    await run.serve();
    const form=await (await fetch(run.origin+"/form.html")).text();assert.ok(form.includes(run.origin+"/slow.html"));
    assert.equal((await fetch(run.origin+"/../../private.txt")).status,404);count++;console.log(`ok ${count} - loopback server serves only fixtures and binds slow link to its port`);
    const t=performance.now();const delayed=await (await fetch(run.origin+"/delay.js")).text();assert.ok(performance.now()-t>=5900);assert.match(delayed,/Slow page loaded/);count++;console.log(`ok ${count} - delayed response waits six seconds`);
    run.report("to measure: the Mac was locked");
    const report=readFileSync(join(run.out,"findings.md"),"utf8");
    assert.ok(report.includes("White body fraction"));assert.ok(!report.includes("| measured |"));assert.equal(run.rows.length,80);count++;console.log(`ok ${count} - report covers both browsers, flags and states without inventing measurements`);
  }finally{
    run.server?.closeAllConnections();await new Promise<void>(r=>run.server?run.server.close(()=>r()):r());
    rmSync(run.work,{recursive:true,force:true});rmSync(run.out,{recursive:true,force:true});
  }
  console.log(JSON.stringify({selfTest:"passed",checks:count}));
}
async function main(){
  if(args.includes("--self-test")){await selfTest();return;}
  if(process.platform!=="darwin")throw Error("Mac only; no app was launched");
  const run=new Run(option("out")??ROOT+"/out");let reason="not measured";
  const stop=()=>{void run.abort("aborted: termination signal");};process.once("SIGINT",stop);process.once("SIGTERM",stop);
  try{
    await run.compile();
    const state=await run.state();run.record("preflight.session",state);run.record("preflight.idle",{seconds:await run.idle()});
    if(state.locked||state.displayAsleep||!state.onConsole)throw new Halt("to measure: the Mac was locked");
    if(!state.axTrusted)throw new Halt("not run: existing AX permission absent; no prompt requested");
    // Do not download or install software. Discover an existing CfT app, or take --cft.
    const cache=join(process.env.HOME??"","Library/Caches/ms-playwright");
    let cft=option("cft");
    if(!cft&&existsSync(cache))cft=(await exec("/usr/bin/find",[cache,"-name","Google Chrome for Testing.app","-prune"])).stdout.trim().split("\n").filter(Boolean).sort().at(-1);
    await run.serve();
    for(const [name,app]of [["Chrome for Testing",cft],["Installed Chrome","/Applications/Google Chrome.app"]] as const){
      if(!app||!existsSync(app)){for(const state of ["uncovered","covered","minimized"] as State[])for(const flags of [false,true])for(const c of ["C1","C2","C3","C4","C5"])run.add(name,state,flags,c,{},"not run: browser app absent; pass --cft");continue;}
      for(const state of ["uncovered","covered","minimized"] as State[])for(const flags of [false,true]){
        const label=`${name.startsWith("Installed")?"chrome":"cft"}-${state}-${flags?"flags":"default"}`;
        for(const c of ["C1C2","C3","C4","C5"]){
          let retry=true;
          while(retry){
            retry=false;
            try{
              await run.launch(app,state,flags,label+"-"+c);
              if(c==="C1C2")await run.c1c2(name,state,flags,label);
              if(c==="C3")await run.c3(name,state,flags,label);
              if(c==="C4")await run.c4(name,state,flags,label);
              if(c==="C5")await run.c5(name,state,flags,label);
            }catch(e){
              if(run.stopped.startsWith("aborted: input resumed")){
                run.record(label+".interrupted",{case:c,reason:run.stopped});
                retry=true;
              }else if(e instanceof Halt||run.stopped)throw e;
              else {
                const error=String(e instanceof Error?e.message:e);
                run.record(label+".case-failed",{case:c,error});
                for(const part of c==="C1C2"?["C1","C2"]:[c])run.add(name,state,flags,part,{error},"not measured: case failed; see JSONL");
              }
            }finally{
              if(run.watchdog)clearInterval(run.watchdog);run.watchdog=undefined;
              run.launching=false;await run.cleanupBrowser();
            }
            if(retry)run.stopped="";
          }
        }
      }
    }
    reason="not measured: case did not yield evidence";
  }catch(e){reason=String(e instanceof Error?e.message:e);run.record("run.stopped",{reason});if(!(e instanceof Halt))process.exitCode=1;}
  finally{run.report(reason);await run.cleanup();process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
