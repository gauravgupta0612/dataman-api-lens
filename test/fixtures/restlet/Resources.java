package demo.shop.rest;
public class Resources {
	public static final String STORE_LIST = "/stores";
	public static final String STOREID = "storeid";
	public static final String STORE = STORE_LIST + "/{" + STOREID + "}";
	public static final String ORDERS = STORE + "/orders";
	public static final String ORDER = ORDERS + "/{orderid}";
	public static final String QUERY_CURRENCY = "currency";
}
