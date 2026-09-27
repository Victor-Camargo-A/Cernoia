export type BusinessSummary = {
 title:string;sections:{key:string;title:string;paragraphs:string[];sources:{document_id:string;name:string}[]}[];
 contracted_documents:number;completed_documents:number;
 recommendations:{contract_types:string[];procurement_methods:{name:string;basis:string;document_ids:string[]}[];can_expand:boolean;message:string;limitation:string;source_url:string;default_filters:{procurement_methods:string[];process_statuses:string[];only_open:boolean}};
};
