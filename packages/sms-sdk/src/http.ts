import { ProviderAuthError } from "./errors.js";
import type { AdapterRejection } from "./types.js";
export async function jsonBody(response:Response):Promise<unknown>{return response.json().catch(()=>undefined);}
export function classifyHttp(status:number, body:unknown, provider:string):AdapterRejection { if(status===401||status===403) throw new ProviderAuthError(`${provider} authentication failed`); const text=typeof body==="object"&&body!==null?JSON.stringify(body):"request rejected"; return {kind:"rejected",message:`${provider} rejected the request (${status})`,eligibleForFallback:status===409||status===422||status===400,status,code:text.slice(0,120)}; }
