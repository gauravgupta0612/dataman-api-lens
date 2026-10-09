package demo.rest;
public class LegacyApplication extends Application {
	public Restlet createInboundRoot() {
		Router router = new Router(getContext());
		router.attach("/legacy/items/{id}", LegacyItemResource.class);
		return router;
	}
}
class LegacyItemResource extends ServerResource {
	@Get("json")
	public String represent() { String q = getQueryValue("q"); return ""; }
	@Delete
	public void remove() {}
}
abstract class BaseAIResource extends ShopListResource {
	@Override
	protected Representation post(Representation entity, Variant variant) {
		JSONObject req = new JSONObject(entity.getText());
		String prompt = req.getString("prompt");
		return null;
	}
}
@Path("/ai/summary")
class SummaryAIResource extends BaseAIResource {
}
