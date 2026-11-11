//! Attribute macros of the paneweft SDK.
//!
//! RED PHASE: compile-only stubs. They accept the documented syntax and generate the trait implementation or test wrapper that
//! compiles, but register nothing, record nothing and publish nothing. The green phase replaces the bodies; the signatures and the
//! attribute grammar are the contract (docs/v1-red-contract.md section 4).
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, Expr, ItemFn, ItemImpl, Lit, Meta};

/// Finds `name = "literal"` in a comma separated attribute list.
fn string_arg(attr: TokenStream, name: &str) -> Option<String> {
    let parsed = syn::parse::Parser::parse(
        syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated,
        attr,
    )
    .ok()?;
    for meta in parsed {
        if let Meta::NameValue(pair) = meta {
            if pair.path.is_ident(name) {
                if let Expr::Lit(literal) = pair.value {
                    if let Lit::Str(text) = literal.lit {
                        return Some(text.value());
                    }
                }
            }
        }
    }
    None
}

/// `#[paneweft::views(type_id = "...")]` on an inherent impl: generates `paneweft::Inspectable` for the (concrete) type.
#[proc_macro_attribute]
pub fn views(attr: TokenStream, item: TokenStream) -> TokenStream {
    let type_id = string_arg(attr, "type_id").unwrap_or_default();
    let mut block = parse_macro_input!(item as ItemImpl);
    for entry in block.items.iter_mut() {
        if let syn::ImplItem::Fn(method) = entry {
            method.attrs.retain(|attribute| {
                attribute.path().segments.last().map(|segment| segment.ident != "view").unwrap_or(true)
            });
        }
    }
    let self_type = block.self_ty.clone();
    let (impl_generics, _, where_clause) = block.generics.split_for_impl();
    let generated = quote! {
        impl #impl_generics ::paneweft::Inspectable for #self_type #where_clause {
            const PANEWEFT_TYPE_ID: &'static str = #type_id;
            fn views(&self, _cx: &mut ::paneweft::Context) -> ::paneweft::ViewSetResult {
                ::paneweft::ViewSetResult::new()
            }
        }
    };
    quote! { #block #generated }.into()
}

/// `#[paneweft::view(...)]` on a method of a `#[paneweft::views]` impl. The `views` macro consumes it; standing alone it is inert.
#[proc_macro_attribute]
pub fn view(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}

/// `#[paneweft::example(id = "...", claims = ["..."])]` on a synchronous function that returns an inspectable value.
#[proc_macro_attribute]
pub fn example(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let function = parse_macro_input!(item as ItemFn);
    let name = function.sig.ident.clone();
    let test_name = syn::Ident::new(&format!("paneweft_example_{}", name), name.span());
    quote! {
        #function
        #[cfg(test)]
        #[test]
        fn #test_name() { let _ = #name(); }
    }
    .into()
}
