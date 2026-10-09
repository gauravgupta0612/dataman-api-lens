<?php
class PostController extends Controller {
    public function store(Request $request) {
        $request->validate(['title' => 'required|string', 'views' => 'integer']);
        $draft = $request->query('draft');
    }
}
