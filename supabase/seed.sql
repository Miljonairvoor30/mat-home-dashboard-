insert into public.competitor_sales_targets
(name, product_url, bol_product_id, ean, seller_name, tracking_mode)
values
('Vicco Wicko 60×76 wit',
 'https://www.bol.com/nl/nl/p/vicco-wicko-wisselblad-60-x-76-cm-wit/9300000229529900/',
 '9300000229529900',
 '4066731491919',
 'ok-living',
 'cart_inference')
on conflict (product_url) do nothing;
