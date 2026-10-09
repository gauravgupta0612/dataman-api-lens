package main
func routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, r *http.Request) { r.URL.Query().Get("fmt") })
	mux.HandleFunc("/legacy", legacy)
}
