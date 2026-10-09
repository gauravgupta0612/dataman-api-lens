<?php
use App\Http\Controllers\PostController;
Route::get('/status', function () { return 'ok'; });
Route::prefix('v1')->group(function () {
    Route::post('/posts', [PostController::class, 'store']);
    Route::apiResource('photos', PhotoController::class);
});
