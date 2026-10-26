import { crisisCheck,crisisResponse,type CrisisResponse } from "../content/crisis.ts";
import { lintText, type LintIssue } from "../content/lint.ts";
import type { UiCopy } from "./types.ts";

export const TEXT_BOXES={startup:140,rally:280,support:280,officeHours:280,mom:280,discovery:280,pivot:280} as const;
export type TextBoxId=keyof typeof TEXT_BOXES;
export type TextGateResult=
  | {readonly kind:"crisis";readonly response:CrisisResponse}
  | {readonly kind:"invalid";readonly reason:"required"|"tooLong"|"blocked";readonly issues?:readonly LintIssue[]}
  | {readonly kind:"ready";readonly text:string};

/** Crisis detection deliberately precedes length checks and every other parser. */
export function gateText(box:TextBoxId,raw:string):TextGateResult {
  const crisis=crisisCheck(raw);
  if(crisis)return {kind:"crisis",response:crisisResponse(crisis.group)};
  const text=raw.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,"").trim();
  if(!text)return {kind:"invalid",reason:"required"};
  if([...text].length>TEXT_BOXES[box])return {kind:"invalid",reason:"tooLong"};
  const issues=lintText(text);
  if(issues.length)return {kind:"invalid",reason:"blocked",issues};
  // Resolvers receive no contact information, addresses or markup delimiters.
  const safe=text.replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi,"[email]")
    .replace(/(?:\+?\d[\s().-]?){7,}/g,"[phone]")
    .replace(/\b\d{1,5}\s+(?:[a-z]+\s){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl)\b/gi,"[address]")
    .replace(/[<>{}`]/g,"");
  return {kind:"ready",text:safe};
}

export interface FreeTextOptions<T> {
  readonly id:TextBoxId;
  readonly label:string;
  readonly submitLabel:string;
  readonly copy:UiCopy;
  /** A pure content matcher returns IDs/enums. It is never called on blocked text. */
  readonly resolve:(text:string)=>T;
  readonly accept:(value:T)=>void;
  readonly crisis?:(active:boolean)=>void;
  readonly choices?:readonly string[];
}
export interface FreeTextControl { readonly element:HTMLElement; focus():void; clear():void; dispose():void }

/** The only component allowed to create a free-form text entry element. */
export function createFreeTextBox<T>(doc:Document,options:FreeTextOptions<T>):FreeTextControl {
  const form=doc.createElement("form");form.className="fc-text-box";form.dataset.textBox=options.id;
  const label=doc.createElement("label");label.textContent=options.label;
  const input=doc.createElement("textarea");input.id=`fc-text-${options.id}`;input.rows=3;input.autocomplete="off";
  input.setAttribute("aria-label",options.label);input.setAttribute("data-free-text","true");
  // Do not use maxLength: truncation could remove a crisis phrase before gate 1.
  const submit=doc.createElement("button");submit.type="submit";submit.textContent=options.submitLabel;
  const feedback=doc.createElement("div");feedback.className="fc-text-feedback";feedback.setAttribute("role","status");feedback.setAttribute("aria-live","polite");
  label.append(input);form.append(label,submit,feedback);
  const accept=(raw:string)=>{
    feedback.replaceChildren();
    const result=gateText(options.id,raw);
    if(result.kind==="crisis") {
      options.crisis?.(true);
      for(const line of result.response.lines){const p=doc.createElement("p");p.textContent=line;feedback.append(p);}
      for(const resource of result.response.resources){const p=doc.createElement("p");p.textContent=`${resource.label}: ${resource.detail}`;feedback.append(p);}
      return;
    }
    options.crisis?.(false);
    if(result.kind==="invalid"){feedback.textContent=options.copy(`ui.text.${result.reason}`,{limit:TEXT_BOXES[options.id]});return;}
    options.accept(options.resolve(result.text));
    input.value="";
  };
  for(const value of options.choices??[]){const choice=doc.createElement("button");choice.type="button";choice.textContent=value;choice.addEventListener("click",()=>accept(value));form.append(choice);}
  const onSubmit=(event:Event)=>{event.preventDefault();accept(input.value);};
  form.addEventListener("submit",onSubmit);
  return {element:form,focus:()=>input.focus(),clear:()=>{input.value="";feedback.replaceChildren();},dispose:()=>{form.removeEventListener("submit",onSubmit);input.value="";form.remove();}};
}
