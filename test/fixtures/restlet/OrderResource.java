package demo.shop.rest;
import org.restlet.representation.Representation;
import org.restlet.representation.Variant;
import org.restlet.resource.ServerResource;

@Path(Resources.ORDER)
public class OrderResource extends ShopListResource {
	@Override
	protected void doInit() {
		storeId = Integer.parseInt(getAttribute(Resources.STOREID));
		String c = getQueryValue(Resources.QUERY_CURRENCY);
	}
	@Override
	protected Representation get(Variant variant) {
		String expand = getQuery().getFirstValue("expand");
		return null;
	}
	@Override
	protected Representation post(Representation entity, Variant variant) {
		final JSONObject jsonRequest = new JSONObject(RequestBodies.read(entity));
		String product = jsonRequest.getString(IConsts.PRODUCT);
		int qty = jsonRequest.getInt(IConsts.QUANTITY);
		String note = jsonRequest.optString(IConsts.NOTE, "");
		JSONObject result = new JSONObject();
		result.put("ok", true);
		return null;
	}
}
