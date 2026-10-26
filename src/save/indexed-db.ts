import type { SaveBackend } from "./store.ts";

/** Browser fallback. A page-storage adapter can be supplied before this backend. */
export class IndexedDbSaveBackend implements SaveBackend {
  readonly name="indexed-db";
  private database:Promise<IDBDatabase>|undefined;
  private readonly factory:IDBFactory;
  private readonly databaseName:string;
  constructor(factory:IDBFactory=indexedDB,databaseName="fog-city-progress"){this.factory=factory;this.databaseName=databaseName;}
  private open():Promise<IDBDatabase>{
    if(!this.database)this.database=new Promise((resolve,reject)=>{
      const request=this.factory.open(this.databaseName,1);let abandoned=false;
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains("saves"))request.result.createObjectStore("saves");};
      request.onsuccess=()=>{const database=request.result;if(abandoned){database.close();return;}database.onversionchange=()=>{database.close();this.database=undefined;};resolve(database);};
      request.onerror=()=>{this.database=undefined;reject(request.error);};request.onblocked=()=>{abandoned=true;this.database=undefined;reject(new Error("Save database is blocked"));};
    });return this.database;
  }
  async read(key:string):Promise<string|null>{const db=await this.open();return new Promise((resolve,reject)=>{const request=db.transaction("saves","readonly").objectStore("saves").get(key);request.onsuccess=()=>resolve(typeof request.result==="string"?request.result:null);request.onerror=()=>reject(request.error);});}
  private async change(operation:(store:IDBObjectStore)=>void):Promise<void>{const db=await this.open();return new Promise((resolve,reject)=>{const transaction=db.transaction("saves","readwrite");transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error??new Error("Save transaction aborted"));operation(transaction.objectStore("saves"));});}
  write(key:string,value:string):Promise<void>{return this.change(store=>{store.put(value,key);});}
  remove(key:string):Promise<void>{return this.change(store=>{store.delete(key);});}
  async close():Promise<void>{const database=await this.database;database?.close();this.database=undefined;}
}
