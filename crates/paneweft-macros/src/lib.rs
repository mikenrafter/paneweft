//! Attribute macros of the paneweft SDK: `views`, `view` and `example`.
//!
//! `#[paneweft::views(type_id = "...")]` on an inherent impl of a CONCRETE type generates the `Inspectable` implementation and one
//! linkme descriptor per annotated method. `#[paneweft::example(id = "...", claims = [...])]` keeps the original function callable
//! (its body runs inside `example::invoke`, so a direct call from another example records a parent edge) and generates the stable
//! libtest wrapper `paneweft_example_<fn>` plus its descriptor. Misuse is a compile error that names the rule and points into the
//! author's file; method bodies are never rewritten, so rustc's own diagnostics keep their spans.
use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{format_ident, quote, quote_spanned};
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{Expr, ExprArray, ImplItem, ItemFn, ItemImpl, Lit, Meta, ReturnType, Token, Type};

/// The `name = value` pairs of an attribute argument list.
struct Args(Vec<(String, Expr, Span)>);

impl Args {
    fn parse(attr: TokenStream2) -> syn::Result<Args> {
        let metas = Punctuated::<Meta, Token![,]>::parse_terminated.parse2(attr)?;
        let mut pairs = Vec::new();
        for meta in metas {
            match meta {
                Meta::NameValue(pair) => {
                    let name = pair.path.get_ident().map(|ident| ident.to_string()).ok_or_else(|| syn::Error::new(pair.path.span(), "expected a plain argument name"))?;
                    pairs.push((name, pair.value, pair.path.span()));
                }
                other => return Err(syn::Error::new(other.span(), "expected `name = value` arguments")),
            }
        }
        Ok(Args(pairs))
    }

    fn get(&self, name: &str) -> Option<&Expr> {
        self.0.iter().find(|(key, _, _)| key == name).map(|(_, value, _)| value)
    }

    fn reject_unknown(&self, allowed: &[&str]) -> syn::Result<()> {
        for (key, _, span) in &self.0 {
            if !allowed.contains(&key.as_str()) {
                return Err(syn::Error::new(*span, format!("unknown argument `{key}`; expected one of: {}", allowed.join(", "))));
            }
        }
        Ok(())
    }

    fn string(&self, name: &str) -> syn::Result<Option<String>> {
        match self.get(name) {
            None => Ok(None),
            Some(Expr::Lit(literal)) => match &literal.lit {
                Lit::Str(text) => Ok(Some(text.value())),
                _ => Err(syn::Error::new(literal.span(), format!("`{name}` must be a string literal"))),
            },
            Some(other) => Err(syn::Error::new(other.span(), format!("`{name}` must be a string literal"))),
        }
    }

    fn required_string(&self, name: &str, attribute: &str) -> syn::Result<String> {
        self.string(name)?.ok_or_else(|| syn::Error::new(Span::call_site(), format!("`#[paneweft::{attribute}]` requires `{name} = \"...\"`")))
    }
}

fn compile_error(error: syn::Error) -> TokenStream {
    error.to_compile_error().into()
}

struct ViewSpec {
    method: syn::Ident,
    id: String,
    title: String,
    question: String,
    component: String,
    priority: TokenStream2,
    fn_span: Span,
    /// The method's `#[cfg(...)]` attributes: everything generated for the view (the call and the descriptor) carries them, so a method
    /// compiled out leaves no reference to itself (S17).
    cfgs: Vec<syn::Attribute>,
}

fn cfg_attributes(attributes: &[syn::Attribute]) -> Vec<syn::Attribute> {
    attributes.iter().filter(|attribute| attribute.path().is_ident("cfg")).cloned().collect()
}

fn is_view_attribute(attribute: &syn::Attribute) -> bool {
    attribute.path().segments.last().is_some_and(|segment| segment.ident == "view")
}

fn read_view(method: &syn::ImplItemFn) -> syn::Result<Option<ViewSpec>> {
    let Some(attribute) = method.attrs.iter().find(|attribute| is_view_attribute(attribute)) else { return Ok(None) };
    let args = Args::parse(attribute.meta.require_list().map(|list| list.tokens.clone()).unwrap_or_default())?;
    args.reject_unknown(&["id", "title", "question", "component", "priority"])?;
    let field = |name: &str| -> syn::Result<String> {
        args.string(name)?.ok_or_else(|| syn::Error::new(attribute.span(), format!("`#[paneweft::view]` requires `{name} = \"...\"`")))
    };
    let component = field("component")?;
    if !["shape", "list", "tree", "graph", "source", "notebook", "example"].contains(&component.as_str()) {
        return Err(syn::Error::new(attribute.span(), format!("`component = \"{component}\"` is not a built-in component; use shape, list, tree, graph, source, notebook or example")));
    }
    let priority = match args.get("priority") {
        Some(expr) => quote!((#expr) as i32),
        None => quote!(50i32),
    };
    Ok(Some(ViewSpec { method: method.sig.ident.clone(), id: field("id")?, title: field("title")?, question: field("question")?, component, priority, fn_span: method.sig.fn_token.span, cfgs: cfg_attributes(&method.attrs) }))
}

/// `#[paneweft::views(type_id = "...")]` on an inherent impl: generates `paneweft::Inspectable` for the (concrete) type.
#[proc_macro_attribute]
pub fn views(attr: TokenStream, item: TokenStream) -> TokenStream {
    match expand_views(attr.into(), item.into()) {
        Ok(tokens) => tokens.into(),
        Err(error) => compile_error(error),
    }
}

fn expand_views(attr: TokenStream2, item: TokenStream2) -> syn::Result<TokenStream2> {
    let args = Args::parse(attr)?;
    args.reject_unknown(&["type_id"])?;
    let type_id = args.required_string("type_id", "views")?;
    let mut block: ItemImpl = syn::parse2(item)?;
    if block.trait_.is_some() {
        return Err(syn::Error::new(block.span(), "`#[paneweft::views]` goes on an inherent impl (`impl Type { ... }`), not a trait impl"));
    }
    if !block.generics.params.is_empty() {
        return Err(syn::Error::new(block.generics.span(), "`#[paneweft::views]` supports concrete types only; register each generic instantiation explicitly with a manual `Inspectable` impl"));
    }
    let mut views = Vec::new();
    for entry in block.items.iter_mut() {
        if let ImplItem::Fn(method) = entry {
            if let Some(spec) = read_view(method)? {
                views.push(spec);
            }
            method.attrs.retain(|attribute| !is_view_attribute(attribute));
        }
    }
    if views.is_empty() {
        return Err(syn::Error::new(block.span(), "`#[paneweft::views]` found no method annotated with `#[paneweft::view(...)]`"));
    }
    let self_type = block.self_ty.clone();
    let runs = views.iter().map(|view| {
        let ViewSpec { method, id, title, question, component, priority, cfgs, .. } = view;
        quote! {
            #(#cfgs)*
            set.run(cx, ::paneweft::ViewMeta { id: #id, title: #title, question: #question, component: #component, priority: #priority }, |cx| self.#method(cx));
        }
    });
    let descriptors = views.iter().map(|view| {
        let ViewSpec { id, title, question, component, priority, fn_span, cfgs, .. } = view;
        let line = quote_spanned!(*fn_span=> ::core::line!());
        quote! {
            #(#cfgs)*
            #[::paneweft::linkme::distributed_slice(::paneweft::catalogue::VIEW_DESCRIPTORS)]
            #[linkme(crate = ::paneweft::linkme)]
            static DESCRIPTOR: ::paneweft::ViewDescriptor = ::paneweft::ViewDescriptor {
                id: #id,
                type_id: #type_id,
                title: #title,
                question: #question,
                component: #component,
                priority: #priority,
                module: ::core::module_path!(),
                source: ::paneweft::SourceLocation { file: ::core::file!(), line: #line },
            };
        }
    });
    let scoped = descriptors.map(|descriptor| quote! { const _: () = { #descriptor }; });
    // a descriptor statement with a `#[cfg]` inside a block is the cfg of that statement; the block itself is always compiled
    Ok(quote! {
        #block
        impl ::paneweft::Inspectable for #self_type {
            const PANEWEFT_TYPE_ID: &'static str = #type_id;
            fn views(&self, cx: &mut ::paneweft::Context) -> ::paneweft::ViewSetResult {
                let mut set = ::paneweft::ViewSetResult::new();
                #(#runs)*
                set
            }
        }
        #(#scoped)*
    })
}

/// `#[paneweft::view(...)]` on a method of a `#[paneweft::views]` impl. The `views` macro consumes it; standing alone it is an error.
#[proc_macro_attribute]
pub fn view(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let _ = item;
    compile_error(syn::Error::new(Span::call_site(), "`#[paneweft::view]` must be used inside a `#[paneweft::views]` impl: put `#[paneweft::views(type_id = \"...\")]` on the `impl` block that contains this method"))
}

/// `#[paneweft::example(id = "...", claims = ["..."])]` on a synchronous function that returns an inspectable value.
#[proc_macro_attribute]
pub fn example(attr: TokenStream, item: TokenStream) -> TokenStream {
    match expand_example(attr.into(), item.into()) {
        Ok(tokens) => tokens.into(),
        Err(error) => compile_error(error),
    }
}

/// The success type of a syntactic `Result<T, E>` return type.
fn result_ok_type(ty: &Type) -> Option<&Type> {
    let Type::Path(path) = ty else { return None };
    let segment = path.path.segments.last()?;
    if segment.ident != "Result" {
        return None;
    }
    let syn::PathArguments::AngleBracketed(arguments) = &segment.arguments else { return None };
    match arguments.args.first()? {
        syn::GenericArgument::Type(inner) => Some(inner),
        _ => None,
    }
}

fn expand_example(attr: TokenStream2, item: TokenStream2) -> syn::Result<TokenStream2> {
    let args = Args::parse(attr)?;
    args.reject_unknown(&["id", "claims", "kind"])?;
    let id = args.required_string("id", "example")?;
    let claims: Vec<String> = match args.get("claims") {
        None => Vec::new(),
        Some(Expr::Array(ExprArray { elems, .. })) => elems
            .iter()
            .map(|element| match element {
                Expr::Lit(literal) => match &literal.lit {
                    Lit::Str(text) => Ok(text.value()),
                    _ => Err(syn::Error::new(element.span(), "claim ids are string literals")),
                },
                _ => Err(syn::Error::new(element.span(), "claim ids are string literals")),
            })
            .collect::<syn::Result<_>>()?,
        Some(other) => return Err(syn::Error::new(other.span(), "`claims` is an array of string literals, e.g. `claims = [\"VW1\"]`")),
    };
    let kind = match args.string("kind")?.as_deref() {
        None | Some("example") => quote!(::paneweft::ExampleKind::Example),
        Some("dead-end") => quote!(::paneweft::ExampleKind::DeadEnd),
        Some(other) => return Err(syn::Error::new(Span::call_site(), format!("`kind = \"{other}\"` is not a kind; use \"example\" or \"dead-end\""))),
    };
    let function: ItemFn = syn::parse2(item)?;
    if function.sig.asyncness.is_some() {
        return Err(syn::Error::new(function.sig.asyncness.span(), "async examples are deferred: an example is a synchronous function in week one"));
    }
    if !function.sig.inputs.is_empty() {
        return Err(syn::Error::new(function.sig.inputs.span(), "examples are zero-argument factories: an example function must take no parameters, because the generated test cannot supply them"));
    }
    if !function.sig.generics.params.is_empty() {
        return Err(syn::Error::new(function.sig.generics.span(), "an example function cannot be generic"));
    }
    let ReturnType::Type(_, return_type) = &function.sig.output else {
        return Err(syn::Error::new(function.sig.span(), "an example must return the inspectable value it builds"));
    };
    let result_ok = result_ok_type(return_type);
    let value_type: &Type = result_ok.unwrap_or(return_type);
    let name = function.sig.ident.clone();
    let wrapper = format_ident!("paneweft_example_{}", name);
    let line = quote_spanned!(function.sig.fn_token.span=> ::core::line!());
    let test_name = quote!(::core::concat!(::core::module_path!(), "::paneweft_example_", ::core::stringify!(#name)));
    let attrs = &function.attrs;
    // the wrapper calls the function, so it is compiled out whenever the function is (S17)
    let cfgs = cfg_attributes(&function.attrs);
    let visibility = &function.vis;
    let body = &function.block;
    let invoke = if result_ok.is_some() {
        quote!(::paneweft::example::invoke_result(&DESCRIPTOR, || -> #return_type #body))
    } else {
        quote!(::paneweft::example::invoke(&DESCRIPTOR, || -> #return_type #body))
    };
    let wrapper_body = if result_ok.is_some() {
        quote!(if let ::core::result::Result::Err(error) = #name() { ::core::panic!("example {} returned Err: {:?}", #id, error); })
    } else {
        quote!(let _ = #name();)
    };
    Ok(quote! {
        #(#attrs)*
        #visibility fn #name() -> #return_type {
            #[::paneweft::linkme::distributed_slice(::paneweft::catalogue::EXAMPLE_DESCRIPTORS)]
            #[linkme(crate = ::paneweft::linkme)]
            static DESCRIPTOR: ::paneweft::ExampleDescriptor = ::paneweft::ExampleDescriptor {
                id: #id,
                type_id: <#value_type as ::paneweft::Inspectable>::PANEWEFT_TYPE_ID,
                claims: &[#(#claims),*],
                module: ::core::module_path!(),
                source: ::paneweft::SourceLocation { file: ::core::file!(), line: #line },
                test_name: #test_name,
                kind: #kind,
            };
            #invoke
        }

        #(#cfgs)*
        #[cfg(test)]
        #[test]
        fn #wrapper() {
            #wrapper_body
        }
    })
}
