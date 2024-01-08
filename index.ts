
import express from "express";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { TiktokenModel, encoding_for_model } from "tiktoken";
import { customsearch } from "@googleapis/customsearch";
import { config } from "dotenv";

const PORT = 8181;
const custom_search = customsearch({
    version: "v1",
    auth: process.env.GOOGLEKEY,
    params: {
        cx: process.env.GOOGLECX
    }
});


try {
    config();
} catch (e) {
    console.log("No .env file found, using environment variables");
    console.log(e);
}

const OpenAIModel = process.env.QUICKMODEL as TiktokenModel || "gpt-3.5-turbo-16k";

const enc = encoding_for_model(OpenAIModel);

const app = express();
app.use(express.json());
app.use(express.static("static"));
app.use((req, res, next) => {

    console.log([
        new Date().toLocaleString().replace(",", ""),
        req.method,
        // fancy path
        req.path.concat((req.path.length > 8) ? "" : "\t").slice(0, 15),
        req.ip,
        req.headers.host
    ].join("\t"));

    next();
});

//const client = new OpenAI({
//    apiKey: process.env.OPENAIKEY,
//    organization: process.env.OPENAIORG
//});

/**
 * Returns an array of paragraphs and the pageIDs. To be sent to the embedder.
 */
const wikiSearch = async (query: string) => {
    const params = new URLSearchParams({
        action: "query",
        // Feed search results into...
        generator: "search",
        gsrlimit: "1",
        gsrsearch: query,
        format: "json",
        //...the extracts module
        prop: "extracts",
        exlimit: "1",
        explaintext: "true"
    });
    const baseURL = "https://en.wikipedia.org/w/api.php";
    const results: {
        [key: string]: {
            extract: string;
        }
    } = (await (await fetch(
        `${baseURL}?${params}`,
        {
            method: "GET",
            headers: {
                "Accept": "application/json",
                // Tell them who we are in case they want to contact us
                "User-Agent": `GPTSearch (${process.env.GHCONTACT})`,
            }
        }
    )).json()).query.pages;
    let paragraphs: string[] = [];
    const pageID = Object.keys(results)[0];
    for (const p of results[pageID].extract.split("\n\n\n")) {
        if (p.includes("== See also ==\n")) break;
        paragraphs.push(p);
    };
    return { paragraphs };
}

const googleSearch = async (query: string) => {
    const results = await custom_search.cse.list({
        cx: process.env.GOOGLECX,
        q: query,
        auth: process.env.GOOGLEKEY,
        num: 5
    });
    let snippets: string[] = [];
    let links: string[] = [];
    if (!results.data.items) return { snippets, links };
    for (const item of results.data.items) {
        snippets.push(item.snippet || "");
        links.push(item.link || "");
    }
    return {
        snippets,
        links
    };
}

class EmbedAPI {
    //baseURL = "http://localhost:4211";
    baseURL = "http://db:4211";

    // TODO: add as batch
    add = async (text: string, pageID?: string) => {
        const response: {
            success: false;
            error: string;
        } | {
            success: true;
            items: number;
        } = await (await fetch(
            `${this.baseURL}/add`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Request-Timeout": "50"
                },
                body: JSON.stringify({ text, pageID })
            }
        )).json();
        return response;
    }

    queryV2 = async (text: string) => {
        const { paragraphs } = await wikiSearch(text);
        const { snippets, links } = await googleSearch(text);
        const lim = 25;
        let n = 0;
        for (let i = 0; i < paragraphs.length; i++) {
            if (n > lim) break;
            n++;
            await this.add(paragraphs[i]);
        }
        for (const snippet of snippets) {
            if (n > lim) break;
            n++;
            await this.add(snippet);
        }
        return {
            query: await this.query(text),
            links: links
        };
    }

    /**
     * 3 most relevant items
     */
    query = async (text: string) => {
        const response: {
            success: boolean;
            items: string[] | undefined;
            error: string | undefined;
        } = await (await fetch(
            `${this.baseURL}/query`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Request-Timeout": "50"
                },
                body: JSON.stringify({ text })
            }
        )).json();
        return response;
    }
}
const embedAPI = new EmbedAPI();


app.post("/browse", async (req, res) => {

    /**
     *  Remove if you aren't deploying your own instance to OpenAI.
     *  Otherwise, you should set the environment variable CHATGPTSECRET
     * to some randomly generated key.
     */
    if (req.headers.authorization !== `Bearer ${process.env.CHATGPTSECRET}`) {
        console.log("Unauthorized request");
        res.status(401).send("Unauthorized");
        return;
    }

    const url: string = req.body.url;
    const topic: string = req.body.topic;
    let results: string[] = [];
    
    const out = await fetch(url).then(r => {
        return r.text();
    }).then(async (response) => {
        const document = new JSDOM(response).window.document;
        let paragraphs: string[] = [];
        for (const element of document.querySelectorAll("p")) {
            if (element.textContent) paragraphs.push(element.textContent);
        }
        paragraphs.forEach(async (p) => {
            let encoded = enc.encode(p);
            let text: string;
            if (encoded.length > 8190) {
                text = new TextDecoder().decode(enc.decode(encoded.slice(0, 8190)));
            } else {
                text = p;
            }
            return await embedAPI.add(text);
        });
        return (await embedAPI.query(topic)).items || [];
    });
    if (out) results.push(...out);
    res.json(results);
});


app.get("/search", async (req, res) => {

    /**
     *  Remove if you aren't deploying your own instance to OpenAI.
     *  Otherwise, you should set the environment variable CHATGPTSECRET
     * to some randomly generated key.
     */
    if (req.headers.authorization !== `Bearer ${process.env.CHATGPTSECRET}`) {
        console.log("Unauthorized request");
        res.status(401).send("Unauthorized");
        return;
    }
    const embedQuery = await embedAPI.queryV2(req.query.q as string);
    res.json({
        results: embedQuery.query.items || ["No results found"],
        links: embedQuery.links,
        date: new Date().toUTCString().replace(",", "").replace(" GMT", "")
    });
});

// TODO: subclass marked.Renderer to make header tags have ids
const renderer = new marked.Renderer();
renderer.heading = (text, level) => {
    const escapedText = text.toLowerCase().replace(/[^\w]+/g, "-");

    return `<h${level} id="${escapedText}"><a href="#${escapedText}">${text}</a><span>🔗</span></h${level}>`;
};

app.get("/privacy", async (_, res) => {
    const md = await marked(await (await fetch("/privacy.md")).text(), { renderer });
    const head = `<head><title>Privacy Policy</title><link rel="stylesheet" href="/style.css"></head>`;
    res.send(`<!DOCTYPE html><html>${head}<body><main>${md}</main><center>© 2023-2024 CyberThing all rights reserved</center></body></html>`);
});

app.listen(PORT, () => {
    try {
        console.log(`Now listening on http://localhost:${PORT}`);

    } catch (e) {
        console.log(e);
    }
});
