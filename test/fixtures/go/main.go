package main

import "github.com/gin-gonic/gin"

type CreateOrder struct {
	Item string `json:"item" binding:"required"`
	Qty  int    `json:"qty"`
}

func main() {
	r := gin.Default()
	v1 := r.Group("/v1")
	v1.GET("/orders/:id", getOrder)
	v1.POST("/orders", func(c *gin.Context) {
		var req CreateOrder
		c.ShouldBindJSON(&req)
	})
	http.Get("http://example.com")
	r.Run(":9090")
}

func getOrder(c *gin.Context) {
	id := c.Param("id")
	verbose := c.Query("verbose")
}
